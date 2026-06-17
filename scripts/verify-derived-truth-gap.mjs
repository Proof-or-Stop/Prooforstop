#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');
const scenario = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload, projectRoot = root) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractJson(text) {
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const looksLikeArray = trimmed.startsWith('[') && !/^\[\d+(?:\.\d+)?s\]/.test(trimmed);
    if (trimmed.startsWith('{') || looksLikeArray) {
      return JSON.parse(text.slice(offset + line.length - trimmed.length));
    }
    offset += line.length + 1;
  }
  throw new Error(`no JSON payload found in output: ${text}`);
}

function shouldRun(...names) {
  return scenario === 'all' || names.includes(scenario);
}

const temp = mkdtempSync(join(tmpdir(), 'lattice-derived-truth-'));

try {
  mkdirSync(join(temp, 'docs', 'requirements', 'decisions'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements', 'extracted'), { recursive: true });
  mkdirSync(join(temp, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(temp, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));

  writeFileSync(join(temp, 'docs', 'requirements', 'decisions', 'primary.md'), [
    '# Primary Truth',
    '',
    '- 需求：系统必须支持真实的主真相源 requirement 覆盖分析。',
    '- 决定：derived 文档只能做参考，不参与 high gap 判定。',
    '',
  ].join('\n'));

  writeFileSync(join(temp, 'docs', 'requirements', 'extracted', 'derived.md'), [
    '# Derived Truth',
    '',
    '- 需求：这是从代码反向提取的 requirement 参考，不应该变成 high uncovered requirement。',
    '- 约束：可以在 summary 里统计，但不是 primary truth。',
    '',
  ].join('\n'));

  if (shouldRun('truth-tier')) {
    const scan = extractJson(run('truth_scan', undefined, temp));
    const primaryRequirement = scan.entries.find((entry) => entry.file === 'decisions/primary.md' && entry.type === 'requirement');
    const derivedRequirement = scan.entries.find((entry) => entry.file === 'extracted/derived.md' && entry.type === 'requirement');
    assert(primaryRequirement?.tier === 'primary', 'primary truth requirement missing primary tier');
    assert(derivedRequirement?.tier === 'derived', 'derived truth requirement missing derived tier');
  }

  if (shouldRun('gap-filters-derived')) {
    const gap = extractJson(run('gap_analyze', undefined, temp));
    const derivedHigh = gap.gaps.filter((item) => item.severity === 'high' && item.source?.file?.startsWith('extracted/'));
    assert(derivedHigh.length === 0, `derived truth should not create high gaps: ${JSON.stringify(derivedHigh)}`);
  }

  if (shouldRun('gap-keeps-primary')) {
    const gap = extractJson(run('gap_analyze', undefined, temp));
    const primaryHigh = gap.gaps.filter((item) => item.severity === 'high' && item.source?.file === 'decisions/primary.md');
    assert(primaryHigh.length >= 1, 'primary truth requirement should still produce a high uncovered requirement');
  }

  if (shouldRun('summary-keeps-derived')) {
    const scan = extractJson(run('truth_scan', { summary: true }, temp));
    assert(Array.isArray(scan.topics), 'truth_scan summary missing topics array');
    assert(scan.topics.includes('Primary Truth'), 'truth_scan summary lost primary topic');
    assert(scan.topics.includes('Derived Truth'), 'truth_scan summary lost derived topic');
  }

  console.log(`derived truth gap verified (${scenario})`);
} finally {
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
