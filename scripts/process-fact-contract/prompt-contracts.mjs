

import { existsSync } from 'node:fs';


import { basename, join } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { canonicalRoleId, requiredReviewerRunIdPromptFiles, reviewPassReviewerPrompts, hanCharacterPattern, passOnlyFindingAddPatterns, currentCategories, legacyCategories, codeLikeCommandNamePattern, artifactFactNamePattern, root, importBuiltModule, fail, rolePromptPath, warn, modularReviewerBootstrapFiles, legacyTestAutoNegatedProcessFactPattern, legacyTestFixtureCommands, legacyTestAutoProcessFactClaimPatterns, legacyAliasDocContextPattern, coverageReviewerLaneNames, coverageReviewerCliCommandPatterns, coverageReviewerLaneContextPattern, assert } from './support.mjs';
import { findUninventoriedProcessFactCommands } from './command-contracts.mjs';
import { extractExportedObjectBody, extractBalancedBlock } from './review-inventory.mjs';
import { readStringProperty, parseStringArrayProperty } from './registry-parser.mjs';
import { extractPhaseToolEntries, commandAllowedByConfiguredPhaseTools } from './registry-alignment.mjs';

export function isReviewerPrompt(relPath, text) {
  const name = `${canonicalRoleId(basename(relPath))}.md`;
  return name.startsWith('proof-or-stop-review-') || requiredReviewerRunIdPromptFiles.has(name) || text.includes('review_pass_set');
}

export function scanBraceState(line, state) {
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

export function commandBlocks(text, command) {
  // `proof-or-stop` is the canonical bin; `proof-or-stop` / `koala` stay accepted so this
  // detector keeps recognizing pre-rename prompt text (B-cdf6 CHK-006).
  const commandPattern = new RegExp(`\\b(?:proof-or-stop|proofOrStop|koala)\\s+${command}\\b`);
  const anyCliCommandPattern = /\b(?:proof-or-stop|proofOrStop|koala)\s+[a-z_][a-z0-9_]*\b/;
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
      if (!state.seenJson && (!trimmed || trimmed.startsWith('```') || anyCliCommandPattern.test(nextLine))) break;

      blockLines.push(nextLine);
      scanBraceState(nextLine, state);
    }

    blocks.push({ block: blockLines.join('\n'), lineNo: index + 1 });
  }

  return blocks;
}

export function requiresReviewPassProtocol(label) {
  const name = `${canonicalRoleId(basename(label))}.md`;
  return reviewPassReviewerPrompts.has(name) || label.startsWith('synthetic-');
}

export function requiresNoFindingReviewPassProtocol(label) {
  return canonicalRoleId(basename(label)) !== 'proof-or-stop-evaluator' && requiresReviewPassProtocol(label);
}

export function hasHardCodedReviewRunIdExample(block) {
  return /\breviewRunId\b[\s\S]{0,160}\b(?:B-[A-Za-z0-9_-]+|<ID>|\$\{[^}]+\}):RR-001\b/.test(block);
}

export function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

export function scanAgentMachineValues(block, label, lineNo) {
  const issues = [];
  for (const match of block.matchAll(/["']?agent["']?\s*:\s*["']([^"']+)["']/g)) {
    const value = match[1];
    if (hanCharacterPattern.test(value)) {
      issues.push(`${label}:${lineNo} machine field "agent" uses non-code value "${value}"; use an English/code-like reviewer id or placeholder`);
    }
  }
  return issues;
}

export function scanPromptText(text, label) {
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

export function scanCliMachineFactNames(text, label) {
  const issues = [];
  for (const match of text.matchAll(/\bname\s*:\s*['"]([^'"]+)['"]/g)) {
    const name = match[1];
    if (hanCharacterPattern.test(name) || (!codeLikeCommandNamePattern.test(name) && !artifactFactNamePattern.test(name))) {
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

export function scanCodeLikeStringArrayConst(text, label, constName) {
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

export function scanReviewRoundPromptSchema(text, label) {
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

export function promptSemanticTokens(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/\bkoala\s+([a-z_][a-z0-9_]*)\b/g)) {
    tokens.add(`cmd:${match[1]}`);
  }
  for (const match of text.matchAll(/(?:^|[\s`"'(])((?:\.koala|\.lattice-codex|\.proof-or-stop-codex|\.claude|docs|packages|bin)\/[A-Za-z0-9._/@:-]+(?:\/[A-Za-z0-9._/@:-]+)*)/g)) {
    tokens.add(`path:${match[1].replace(/[),.;:]+$/, '')}`);
  }
  for (const name of ['review_run_start', 'finding_add', 'review_pass_set', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'verification_evidence_add', 'verification_evidence_batch_add']) {
    if (text.includes(name)) tokens.add(`cmd:${name}`);
  }
  return [...tokens].sort();
}

export async function comparePromptSemantics(promptMap) {
  const templateDir = 'packages/main/templates/agents';
  // B-cc10 F-055: include the canonical adapter mirror; the renamed one yields nothing.
  // B-cc10 F-056: compare against mirror dirs that EXIST. Listing an absent dir made every
  // role warn 'missing; no semantic drift comparison available' — 17 lines of noise that
  // buried real signal, and (before the canonical dir was added) meant zero mirrors were
  // compared at all while the check still exited 0 because the miss only warn()s.
  const mirrorDirs = ['.claude/agents', '.proof-or-stop-codex/agents', '.proof-or-stop-codex/agents']
    .filter((dir) => existsSync(join(root, dir)));
  const registryModule = await importBuiltModule('packages/main/dist/core/prompt-registry.js');
  if (!registryModule?.readPromptRegistry || !registryModule?.renderPromptEntryForHost) {
    fail('packages/main/dist/core/prompt-registry.js must expose the canonical host prompt renderer');
    return;
  }
  const registryByFile = new Map(
    registryModule.readPromptRegistry().agents.map(entry => [entry.file, entry]),
  );
  const templateFiles = [...promptMap.keys()]
    .filter(relPath => relPath.startsWith(`${templateDir}/`))
    .sort();

  for (const templateRel of templateFiles) {
    const name = `${canonicalRoleId(basename(templateRel))}.md`;
    const entry = registryByFile.get(name);
    if (!entry) {
      fail(`${templateRel} is missing from the canonical prompt registry`);
      continue;
    }
    for (const mirrorDir of mirrorDirs) {
      const mirrorRel = rolePromptPath(mirrorDir, name);
      if (!promptMap.has(mirrorRel)) {
        warn(`${mirrorRel} missing; no semantic drift comparison available`);
        continue;
      }
      if (modularReviewerBootstrapFiles.has(name)) {
        const bootstrap = promptMap.get(mirrorRel);
        if (!bootstrap.includes('review_run_start') || bootstrap.includes('finding_add') || bootstrap.includes('review_pass_set')) {
          fail(`${mirrorRel} must be a body-free reviewer bootstrap that selects exactly one runtime prompt`);
        }
        continue;
      }
      const host = mirrorDir === '.claude/agents' ? 'claude' : 'codex';
      const canonicalTokens = promptSemanticTokens(
        registryModule.renderPromptEntryForHost(entry, host),
      );
      const mirrorTokens = promptSemanticTokens(promptMap.get(mirrorRel));
      const missing = canonicalTokens.filter(token => !mirrorTokens.includes(token));
      const extra = mirrorTokens.filter(token => !canonicalTokens.includes(token));
      if (missing.length || extra.length) {
        const changed = [...missing, ...extra];
        const commandOrPathDrift = changed.some(token => token.startsWith('cmd:') || token.startsWith('path:'));
        const message = `${mirrorRel} command/path semantics drifted from canonical ${host} host render for ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
        if (commandOrPathDrift) fail(message);
        else warn(message);
      }
    }
  }
}

export function paragraphBlocks(text) {
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

export function scanActiveLifecycleDocText(text, label) {
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
    if (/\bkoala\s+validate\b/.test(line)) {
      const lineNo = index + 1;
      const context = lines
        .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
        .join('\n');
      if (!legacyAliasDocContextPattern.test(context)) {
        issues.push(`${label}:${lineNo} active lifecycle docs must use proof-or-stop validate as current primary; koala validate may appear only as a legacy alias/compat reference`);
      }
    }

    const coverageReviewerLane = coverageReviewerLaneNames.find(name => line.includes(name));
    if (!coverageReviewerLane) continue;

    const lineNo = index + 1;
    for (const { label: claimLabel, pattern } of coverageReviewerCliCommandPatterns) {
      if (pattern.test(line)) {
        issues.push(`${label}:${lineNo} ${coverageReviewerLane} must not be documented as a CLI/tool command (${claimLabel})`);
      }
    }

    const context = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
      .join('\n');
    if (!coverageReviewerLaneContextPattern.test(context)) {
      issues.push(`${label}:${lineNo} ${coverageReviewerLane} must be described as a reviewer agent/lane`);
    }
  }

  return issues;
}

export function assertSyntheticAdversarialChecks() {
  const badPassOnlyLines = [
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"文档一致性检查通过","severity":"low","category":"happy","agent":"proof-or-stop-review-docs"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"consistency check PASSED","severity":"low","category":"happy","agent":"proof-or-stop-review-docs"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"no findings","severity":"low","category":"happy","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"PASS","severity":"low","category":"happy","agent":"proof-or-stop-review-quality"}\'',
  ];
  for (const [index, line] of badPassOnlyLines.entries()) {
    assert(
      scanPromptText(line, `synthetic-pass-only-${index}`).some(issue => issue.includes('pass-only finding_add')),
      `synthetic pass-only finding_add prompt ${index + 1} should fail`,
    );
  }
  const multilinePassOnly = [
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"PASS",',
    '  severity:"low",',
    '  category:"happy",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilinePassOnly, 'synthetic-multiline-pass-only').some(issue => issue.includes('pass-only finding_add')),
    'synthetic multiline pass-only finding_add prompt should fail',
  );

  const noReviewPass = [
    'Use proof-or-stop finding_add for every problem.',
    'No findings. Review passed.',
  ].join('\n');
  assert(
    scanPromptText(noReviewPass, 'synthetic-no-review-pass').some(issue => issue.includes('review_pass_set')),
    'synthetic no-finding prompt without review_pass_set should fail',
  );

  const activeLegacy = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"cleanup","severity":"medium","category":"cleanup","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(activeLegacy, 'synthetic-active-legacy').some(issue => issue.includes('legacy category')),
    'synthetic active legacy category should fail',
  );
  const multilineLegacy = [
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"cleanup",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineLegacy, 'synthetic-multiline-legacy').some(issue => issue.includes('legacy category')),
    'synthetic multiline legacy category should fail',
  );

  const unknownCategory = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"docs","severity":"medium","category":"docs","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(unknownCategory, 'synthetic-unknown-category').some(issue => issue.includes('unknown category')),
    'synthetic unknown category should fail',
  );
  const literalReviewRunId = 'proof-or-stop finding_add \'{"storyId":"B-x","reviewRunId":"B-x:RR-001","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(literalReviewRunId, 'synthetic-literal-review-run-id').some(issue => issue.includes('hard-coded RR-001')),
    'synthetic literal RR-001 reviewer command should fail',
  );
  const missingFindingReviewRunId = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(missingFindingReviewRunId, 'packages/main/templates/agents/proof-or-stop-review-story-init.md')
      .some(issue => issue.includes('finding_add example must include reviewRunId')),
    'synthetic reviewer finding_add JSON example without reviewRunId should fail',
  );
  const missingPassReviewRunId = 'proof-or-stop review_pass_set \'{"storyId":"B-x","agent":"proof-or-stop-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'';
  assert(
    scanPromptText(missingPassReviewRunId, 'packages/main/templates/agents/proof-or-stop-evaluator.md')
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
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"docs",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineUnknown, 'synthetic-multiline-unknown').some(issue => issue.includes('unknown category')),
    'synthetic multiline unknown category should fail',
  );

  const goodPrompt = [
    'proof-or-stop review_run_start \'{"storyId":"B-x","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","reviewRunId":"<reviewRunId from review_run_start>","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop review_pass_set \'{"storyId":"B-x","agent":"proof-or-stop-review-quality","reviewRunId":"<reviewRunId from review_run_start>","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const localizedAgentPlaceholder = 'proof-or-stop review_run_start \'{"storyId":"B-x","agent":"<本 reviewer 名>"}\'';
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
    '    replacement: `Use proof-or-stop validate --story=<storyId> and record verificationEvidence`,',
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

  const badCoverageToolDoc = '| `proof-or-stop-review-test-coverage` | 检查 verificationIntent 覆盖 |';
  assert(
    scanActiveLifecycleDocText(badCoverageToolDoc, 'synthetic-coverage-tool-doc').some(issue => issue.includes('CLI/tool command')),
    'synthetic coverage reviewer documented as a tool table row should fail',
  );

  const badCoverageBareDoc = '`proof-or-stop-review-test-coverage` checks coverage.';
  assert(
    scanActiveLifecycleDocText(badCoverageBareDoc, 'synthetic-coverage-bare-doc').some(issue => issue.includes('reviewer agent/lane')),
    'synthetic bare coverage reviewer name without reviewer/lane context should fail',
  );

  const goodCoverageLaneDoc = 'reviewer lane `proof-or-stop-review-test-coverage` checks verificationIntent coverage and uses review_pass_set when no blocker exists.';
  assert(
    scanActiveLifecycleDocText(goodCoverageLaneDoc, 'synthetic-coverage-good-doc').length === 0,
    'synthetic coverage reviewer lane wording should pass',
  );

  const badKoalaValidatePrimaryDoc = 'TEST 阶段运行 `koala validate`，写 validation evidence。';
  assert(
    scanActiveLifecycleDocText(badKoalaValidatePrimaryDoc, 'synthetic-koala-validate-primary-doc').some(issue => issue.includes('proof-or-stop validate as current primary')),
    'synthetic active lifecycle doc that documents koala validate as current primary should fail',
  );

  const goodKoalaValidateAliasDoc = 'TEST 阶段运行 `proof-or-stop validate`（legacy alias: `koala validate`），写 validation evidence。';
  assert(
    scanActiveLifecycleDocText(goodKoalaValidateAliasDoc, 'synthetic-koala-validate-alias-doc').length === 0,
    'synthetic active lifecycle doc may mention koala validate only as a legacy alias',
  );
}
