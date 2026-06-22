#!/usr/bin/env node

/**
 * @task TOOL-002
 * @title 结构化注释校验脚本
 * @type feature
 * @priority high
 * @date 2026-03-31
 * @description
 *   校验项目中所有 JS/TS 文件的 @task 注释块是否符合规范，
 *   检查必填字段缺失、字段值非法、文件缺少注释等问题。
 *   用于 CI/编译阶段卡控质量。
 * @changes
 *   - 新增 scripts/validate-tasks.js
 *   - package.json 添加 lint:tasks 脚本
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

// ── 配置 ──────────────────────────────────────────

const EXTENSIONS = new Set(['.ts', '.tsx']);
const SCAN_DIR = 'packages/main';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const REQUIRED_FIELDS = ['task', 'checklist', 'title', 'type', 'priority', 'description', 'changes'];

const VALID_VALUES = {
  type: ['feature', 'bugfix', 'refactor', 'chore'],
  priority: ['critical', 'high', 'medium', 'low'],
  scope: ['file', 'module', 'function', 'block'],
};

// ── 文件遍历 ───────────────────────────────────────

function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full));
    } else if (EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

// ── 注释块提取 ─────────────────────────────────────

function extractBlocks(content) {
  const blocks = [];
  const regex = /\/\*\*[\s\S]*?\*\//g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const block = match[0];
    if (!block.includes('@task')) continue;
    const line = content.slice(0, match.index).split('\n').length;
    blocks.push({ raw: block, line });
  }
  return blocks;
}

function parseBlock(raw) {
  const lines = raw
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, ''));

  const result = {};
  let currentField = null;
  let currentLines = [];

  function flush() {
    if (!currentField) return;
    const value = currentLines.filter(Boolean);
    if (['description', 'changes', 'affected'].includes(currentField)) {
      result[currentField] = value.map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    } else {
      result[currentField] = currentLines.join(' ').trim();
    }
    currentField = null;
    currentLines = [];
  }

  for (const line of lines) {
    const tagMatch = line.match(/^@(\w[\w-]*)\s*(.*)/);
    if (tagMatch) {
      flush();
      currentField = tagMatch[1];
      const val = tagMatch[2].trim();
      currentLines = val ? [val] : [];
    } else if (currentField) {
      currentLines.push(line);
    }
  }
  flush();
  return result;
}

// ── 校验逻辑 ───────────────────────────────────────

function validateBlock(parsed, filePath, line) {
  const errors = [];
  const loc = `${filePath}:${line}`;

  // 必填字段检查
  for (const field of REQUIRED_FIELDS) {
    const val = parsed[field];
    if (!val || (Array.isArray(val) && val.length === 0)) {
      errors.push({ loc, level: 'error', msg: `missing required field: @${field}` });
    }
  }

  // 枚举值检查
  for (const [field, allowed] of Object.entries(VALID_VALUES)) {
    if (parsed[field] && !allowed.includes(parsed[field])) {
      errors.push({
        loc,
        level: 'error',
        msg: `invalid @${field}: "${parsed[field]}" (allowed: ${allowed.join(', ')})`,
      });
    }
  }

  // task ID 格式检查
  if (parsed.task && !/^[A-Z][\w-]+$/.test(parsed.task)) {
    errors.push({
      loc,
      level: 'warn',
      msg: `@task ID "${parsed.task}" format unusual (expected: B-001, ADHOC-xxx, TOOL-001)`,
    });
  }

  // description 不能太短
  if (parsed.description && Array.isArray(parsed.description)) {
    const text = parsed.description.join(' ');
    if (text.length < 10) {
      errors.push({ loc, level: 'warn', msg: `@description too short (${text.length} chars)` });
    }
  }

  return errors;
}

// ── 主流程 ─────────────────────────────────────────

const rootDir = process.cwd();
const scanRoot = join(rootDir, SCAN_DIR);
let files;
try {
  files = walkDir(scanRoot);
} catch {
  console.log(`Directory "${SCAN_DIR}/" not found, nothing to validate.`);
  process.exit(0);
}

let totalErrors = 0;
let totalWarnings = 0;
let totalTasks = 0;
let filesWithoutTask = [];

for (const filePath of files) {
  const rel = relative(rootDir, filePath);
  const content = readFileSync(filePath, 'utf-8');
  const blocks = extractBlocks(content);

  if (blocks.length === 0) {
    filesWithoutTask.push(rel);
    continue;
  }

  for (const { raw, line } of blocks) {
    const parsed = parseBlock(raw);
    if (!parsed.task) continue;
    totalTasks++;

    const issues = validateBlock(parsed, rel, line);
    for (const issue of issues) {
      if (issue.level === 'error') {
        totalErrors++;
        console.error(`  ERROR  ${issue.loc}  ${issue.msg}`);
      } else {
        totalWarnings++;
        console.warn(`  WARN   ${issue.loc}  ${issue.msg}`);
      }
    }
  }
}

// ── 汇总报告 ───────────────────────────────────────

console.log('');
console.log('── Task Annotation Report ──');
console.log(`  Files scanned:    ${files.length}`);
console.log(`  Tasks found:      ${totalTasks}`);
console.log(`  Errors:           ${totalErrors}`);
console.log(`  Warnings:         ${totalWarnings}`);

if (filesWithoutTask.length > 0) {
  console.log(`  Files without @task (${filesWithoutTask.length}):`);
  for (const f of filesWithoutTask) {
    console.log(`    - ${f}`);
  }
}

console.log('');

if (totalErrors > 0) {
  console.error(`FAILED: ${totalErrors} error(s) found. Fix them before proceeding.`);
  process.exit(1);
} else {
  console.log('PASSED: All task annotations are valid.');
  process.exit(0);
}
