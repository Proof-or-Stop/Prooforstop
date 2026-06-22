#!/usr/bin/env node

/**
 * @task TOOL-001
 * @title 结构化注释提取脚本
 * @type feature
 * @priority high
 * @date 2026-03-31
 * @description
 *   扫描项目中所有 JS/TS 文件，提取 @task 结构化注释块，
 *   解析为 JSON 并支持 Markdown 报告输出。
 * @changes
 *   - 新增 scripts/extract-tasks.js.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, extname } from 'path';

// ── 配置 ──────────────────────────────────────────

const EXTENSIONS = new Set(['.ts', '.tsx']);
const SCAN_DIR = 'packages/main';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const SINGLE_FIELDS = new Set([
  'task', 'checklist', 'title', 'type', 'priority', 'version',
  'scope', 'depends', 'author', 'date',
]);
const MULTI_FIELDS = new Set(['description', 'changes', 'affected']);

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

// ── 注释块解析 ─────────────────────────────────────

function extractBlocks(content) {
  const blocks = [];
  const regex = /\/\*\*[\s\S]*?\*\//g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const block = match[0];
    if (!block.includes('@task')) continue;

    // 计算行号
    const line = content.slice(0, match.index).split('\n').length;
    blocks.push({ raw: block, line });
  }
  return blocks;
}

function parseBlock(raw) {
  // 去掉 /** */ 边界和每行的 * 前缀
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
    if (MULTI_FIELDS.has(currentField)) {
      result[currentField] = currentLines
        .map(l => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
      // description 合并为字符串
      if (currentField === 'description') {
        result[currentField] = result[currentField].join('\n');
      }
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
      const tag = tagMatch[1];
      const value = tagMatch[2].trim();
      if (SINGLE_FIELDS.has(tag)) {
        currentField = tag;
        currentLines = value ? [value] : [];
      } else if (MULTI_FIELDS.has(tag)) {
        currentField = tag;
        currentLines = value ? [value] : [];
      } else {
        // 未知字段也保留
        currentField = tag;
        currentLines = value ? [value] : [];
      }
    } else if (currentField) {
      currentLines.push(line);
    }
  }
  flush();

  // depends / checklist 拆分为数组
  if (result.depends) {
    result.depends = result.depends.split(/[,;]\s*/).filter(Boolean);
  }
  if (result.checklist) {
    result.checklist = result.checklist.split(/[,;]\s*/).filter(Boolean);
  }

  return result;
}

// ── 扫描入口 ───────────────────────────────────────

function scan(rootDir) {
  const files = walkDir(rootDir);
  const tasks = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const blocks = extractBlocks(content);

    for (const { raw, line } of blocks) {
      const parsed = parseBlock(raw);
      if (!parsed.task) continue;
      tasks.push({
        ...parsed,
        sourceFile: relative(rootDir, filePath),
        sourceLine: line,
      });
    }
  }

  return tasks;
}

// ── 筛选 ──────────────────────────────────────────

function filterTasks(tasks, filters) {
  return tasks.filter(t => {
    if (filters.type && t.type !== filters.type) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.version && t.version !== filters.version) return false;
    if (filters.id && t.task !== filters.id) return false;
    return true;
  });
}

// ── Markdown 输出 ──────────────────────────────────

function toMarkdown(tasks) {
  if (tasks.length === 0) return '> No tasks found.\n';

  const lines = [`# Task Report`, ``, `> ${tasks.length} task(s) found`, ``];

  for (const t of tasks) {
    lines.push(`## ${t.task}: ${t.title || 'Untitled'}`);
    lines.push(``);

    const meta = [];
    if (t.type) meta.push(`**Type:** ${t.type}`);
    if (t.priority) meta.push(`**Priority:** ${t.priority}`);
    if (t.version) meta.push(`**Version:** ${t.version}`);
    if (t.scope) meta.push(`**Scope:** ${t.scope}`);
    if (t.author) meta.push(`**Author:** ${t.author}`);
    if (t.date) meta.push(`**Date:** ${t.date}`);
    if (t.checklist) meta.push(`**Checklist:** ${t.checklist.join(', ')}`);
    if (t.depends) meta.push(`**Depends:** ${t.depends.join(', ')}`);
    meta.push(`**Source:** \`${t.sourceFile}:${t.sourceLine}\``);
    lines.push(meta.join(' | '));
    lines.push(``);

    if (t.description) {
      lines.push(`### Description`);
      lines.push(t.description);
      lines.push(``);
    }

    if (t.changes && t.changes.length > 0) {
      lines.push(`### Changes`);
      for (const c of t.changes) lines.push(`- ${c}`);
      lines.push(``);
    }

    if (t.affected && t.affected.length > 0) {
      lines.push(`### Affected Files`);
      for (const a of t.affected) lines.push(`- ${a}`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────

function printUsage() {
  console.log(`
Usage: node scripts/extract-tasks.js [options]

Options:
  --format <json|markdown>   Output format (default: json)
  --type <type>              Filter by type: feature|bugfix|refactor|chore
  --priority <priority>      Filter by priority: critical|high|medium|low
  --version <version>        Filter by version
  --id <task-id>             Filter by task ID
  --output <file>            Write output to file instead of stdout
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--format':   args.format = argv[++i]; break;
      case '--type':     args.type = argv[++i]; break;
      case '--priority': args.priority = argv[++i]; break;
      case '--version':  args.version = argv[++i]; break;
      case '--id':       args.id = argv[++i]; break;
      case '--output':   args.output = argv[++i]; break;
      case '--help':     args.help = true; break;
    }
  }
  return args;
}

// ── Main ──────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.help) {
  printUsage();
  process.exit(0);
}

const rootDir = process.cwd();
const scanRoot = join(rootDir, SCAN_DIR);
let tasks = scan(scanRoot);

tasks = filterTasks(tasks, {
  type: args.type,
  priority: args.priority,
  version: args.version,
  id: args.id,
});

const format = args.format || 'json';
let output;

if (format === 'markdown') {
  output = toMarkdown(tasks);
} else {
  output = JSON.stringify(tasks, null, 2);
}

if (args.output) {
  writeFileSync(args.output, output, 'utf-8');
  console.log(`Written to ${args.output} (${tasks.length} tasks)`);
} else {
  console.log(output);
}
