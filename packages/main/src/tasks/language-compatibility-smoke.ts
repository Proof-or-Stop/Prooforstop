#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSections, validateBackground } from '../core/background-validator.js';
import { resetConfigCache } from '../core/config.js';
import { scanTruth } from './truth.js';

const englishBackground = [
  '## Trigger Event',
  '2026-06-04 B-lang regression locks the canonical English background section names used by mechanical CLI entrypoints.',
  '',
  '## Key Insights',
  'The validator should expose and consume English canonical wording; language-specific interpretation happens before CLI invocation.',
  '',
  '## Solution Tradeoffs',
  'Use canonical English section names for stored output and error messages, while preserving arbitrary Unicode body text as data.',
  '',
  '## Conversational Texture',
  'The user asked for English-first mechanical rules, with agents converting user language into canonical schema before calling Lattice.',
].join('\n');

const nonCanonicalHeadingBackground = [
  '## \u89e6\u53d1\u4e8b\u4ef6',
  '2026-06-04 B-lang regression intentionally uses a non-canonical heading so the mechanical validator rejects direct localized section names.',
  '',
  '## \u5173\u952e\u6d1e\u5bdf',
  'The body is intentionally English so the source file stays Han-free while the escaped heading remains non-canonical input.',
  '',
  '## \u65b9\u6848\u53d6\u820d',
  'This direct localized heading should not be treated as a mechanical alias; callers must convert it before submitting.',
  '',
  '## \u5bf9\u8bdd\u7eb9\u7406',
  'Unicode text can still exist as content, but section names are canonical English at the CLI boundary.',
].join('\n');

assert.deepEqual(validateBackground(englishBackground), { ok: true });
assert.equal(validateBackground(nonCanonicalHeadingBackground).ok, false, 'non-canonical localized headings should not be accepted directly');

const unicodeBodyBackground = [
  '## Trigger Event',
  '2026-06-04 B-lang regression keeps canonical headings while preserving Unicode body text: \u7528\u6237\u8bf4\u9700\u8981\u82f1\u6587\u89c4\u5219.',
  '',
  '## Key Insights',
  'Body text may contain arbitrary Unicode data such as \u8bed\u4e49 and must not be lost during section parsing.',
  '',
  '## Solution Tradeoffs',
  'Do not use Unicode body prose as a rule alias; only canonical heading names define the mechanical sections.',
  '',
  '## Conversational Texture',
  'Agents may understand localized user wording, but they submit canonical English field names and headings to the CLI.',
].join('\n');
const parsed = parseSections(unicodeBodyBackground);
assert.ok(parsed.sections.get('Trigger Event')?.includes('\u82f1\u6587\u89c4\u5219'), 'Unicode body text should be preserved under canonical heading');
assert.ok(parsed.sections.get('Key Insights')?.includes('\u8bed\u4e49'), 'Unicode insight body text should be preserved');

const root = mkdtempSync(join(tmpdir(), 'lattice-language-compat-'));
try {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }));

  const decisionsDir = join(root, 'docs/requirements/decisions');
  mkdirSync(decisionsDir, { recursive: true });

  const localizedDecision = 'Decision: \u9009\u62e9\u4fdd\u7559 Unicode \u8f93\u5165\u8bed\u4e49';
  const localizedRequirement = 'Requirement: \u7cfb\u7edf\u5fc5\u987b\u4fdd\u7559\u5386\u53f2\u6587\u672c\u6458\u8981';
  const localizedConstraint = 'Constraint: \u4e0d\u5141\u8bb8\u56e0\u4e3a\u975e\u82f1\u6587\u5c31\u4e22\u5931\u626b\u63cf\u7ed3\u679c';
  const localizedQuestion = 'Pending: Unicode \u6458\u8981\u662f\u5426\u4fdd\u6301\u539f\u6837';
  writeFileSync(join(decisionsDir, 'localized.md'), [
    '# Canonical Truth With Unicode Data',
    localizedDecision,
    localizedRequirement,
    localizedConstraint,
    localizedQuestion,
  ].join('\n'));

  const localizedOnlyDecision = '\u51b3\u7b56\uff1a\u9009\u62e9\u4fdd\u7559 Unicode \u8f93\u5165\u8bed\u4e49';
  writeFileSync(join(decisionsDir, 'localized-only.md'), [
    '# Localized Only Truth',
    localizedOnlyDecision,
  ].join('\n'));

  writeFileSync(join(decisionsDir, 'english.md'), [
    '# English Truth',
    'Decision: choose English canonical labels for newly rendered Lattice output.',
    'Requirement: the scanner must keep producing entries for historical requirements.',
    'Constraint: not allowed to discard Unicode summaries.',
    'Pending: confirm whether more aliases should move to configuration.',
  ].join('\n'));

  resetConfigCache();
  const truth = scanTruth(root);
  assert.ok(truth.entries.some(entry => entry.type === 'decision' && entry.summary === localizedDecision), 'localized decision should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'requirement' && entry.summary === localizedRequirement), 'localized requirement should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'constraint' && entry.summary === localizedConstraint), 'localized constraint should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'question' && entry.summary === localizedQuestion), 'localized question should be extracted');
  assert.ok(!truth.entries.some(entry => entry.summary === localizedOnlyDecision), 'localized-only semantic keyword should not be mechanically classified');
  assert.ok(truth.entries.some(entry => entry.file === 'decisions/english.md' && entry.type === 'decision'), 'English decision extraction should still work');

  const summary = scanTruth(root, { summary: true })._summary ?? '';
  assert.match(summary, /decisions\/localized\.md .*: 4 entries/);
  assert.match(summary, /decisions\/localized-only\.md .*: 0 entries/);
  assert.match(summary, /decisions\/english\.md .*: 4 entries/);
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}

console.log('\u2713 language compatibility smoke passed');
