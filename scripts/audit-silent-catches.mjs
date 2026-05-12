#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { extname, join, relative } from 'path';

const root = process.cwd();
const scanRoot = join(root, 'packages', 'main', 'src');
const baselinePath = join(root, 'scripts', 'audit-silent-catches-baseline.json');
const BASELINE_VERSION = 1;
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const CATEGORIES = ['DEBUG', 'PROBE', 'PERSIST', 'MUTATION'];
const updateBaseline = process.argv.includes('--update-baseline');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walk(full));
    } else if (EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

function classify(line, nextLine, prevLine) {
  const window = `${prevLine}\n${line}\n${nextLine}`;
  for (const category of CATEGORIES) {
    if (window.includes(category)) return category;
  }
  if (window.includes('debug')) return 'DEBUG';
  if (window.includes('probe')) return 'PROBE';
  if (window.includes('persist')) return 'PERSIST';
  if (window.includes('mutation')) return 'MUTATION';
  return 'uncategorized';
}

function recordKey(record) {
  return `${record.file}:${record.line}:${record.snippet}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function loadBaseline() {
  assert(existsSync(baselinePath), `Missing silent catch baseline: ${baselinePath}. Run node scripts/audit-silent-catches.mjs --update-baseline after reviewing current debt.`);
  const data = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert(data.version === BASELINE_VERSION, `Unsupported silent catch baseline version: ${data.version}`);
  assert(data.scanRoot === 'packages/main/src', `Unexpected silent catch baseline scanRoot: ${data.scanRoot}`);
  assert(Array.isArray(data.uncategorizedCatchKeys), 'silent catch baseline must contain uncategorizedCatchKeys array');
  assert(data.uncategorizedCatchKeys.every((key) => typeof key === 'string' && key.length > 0), 'silent catch baseline keys must be non-empty strings');
  const unique = new Set(data.uncategorizedCatchKeys);
  assert(unique.size === data.uncategorizedCatchKeys.length, 'silent catch baseline contains duplicate keys');
  return data;
}

function writeBaseline(keys) {
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        version: BASELINE_VERSION,
        scanRoot: 'packages/main/src',
        policy: 'Existing uncategorized catch blocks are tracked as baseline debt; new uncategorized catch keys fail audit:silent-catches.',
        uncategorizedCatchKeys: keys,
      },
      null,
      2,
    ) + '\n',
  );
}

const records = [];
for (const file of walk(scanRoot)) {
  const rel = relative(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcatch\s*(\(|\{)/.test(lines[i])) continue;
    const category = classify(lines[i], lines[i + 1] || '', lines[i - 1] || '');
    records.push({
      file: rel,
      line: i + 1,
      category,
      snippet: lines[i].trim(),
    });
  }
}

const summary = Object.fromEntries(['DEBUG', 'PROBE', 'PERSIST', 'MUTATION', 'uncategorized'].map((key) => [key, 0]));
for (const record of records) summary[record.category] += 1;

const uncategorized = records.filter((record) => record.category === 'uncategorized');
const currentUncategorizedKeys = sortedUnique(uncategorized.map(recordKey));

if (updateBaseline) {
  writeBaseline(currentUncategorizedKeys);
}

const baseline = loadBaseline();
const baselineKeys = new Set(baseline.uncategorizedCatchKeys);
const currentKeys = new Set(currentUncategorizedKeys);
const newUncategorizedKeys = currentUncategorizedKeys.filter((key) => !baselineKeys.has(key));
const resolvedBaselineKeys = baseline.uncategorizedCatchKeys.filter((key) => !currentKeys.has(key));
const status = newUncategorizedKeys.length === 0 ? 'silent catch audit passed' : 'silent catch audit failed';

const output = {
  status,
  total: records.length,
  summary,
  baseline: {
    path: relative(root, baselinePath),
    version: baseline.version,
    uncategorizedDebt: baseline.uncategorizedCatchKeys.length,
    newUncategorized: newUncategorizedKeys.length,
    resolvedBaselineDebt: resolvedBaselineKeys.length,
    updated: updateBaseline,
  },
  newUncategorized: newUncategorizedKeys.slice(0, 50),
  resolvedBaselineDebt: resolvedBaselineKeys.slice(0, 50),
  uncategorized: uncategorized.slice(0, 50),
};

console.log(JSON.stringify(output, null, 2));

if (newUncategorizedKeys.length > 0) {
  process.exitCode = 1;
}
