#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { extname, join, relative } from 'path';

const root = process.cwd();
const scanRoot = join(root, 'packages', 'main', 'src');
const baselinePath = join(root, 'scripts', 'audit-silent-catches-baseline.json');
const BASELINE_VERSION = 2;
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

function normalizeContext(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function hashContext(value) {
  return createHash('sha256').update(normalizeContext(value)).digest('hex').slice(0, 12);
}

function scanCatchRecordsInLines(file, lines) {
  const records = [];
  const contextCounts = new Map();
  let catchOrdinal = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/\bcatch\s*(\(|\{)/.test(lines[i])) continue;
    catchOrdinal += 1;
    const prevLine = lines[i - 1] || '';
    const nextLine = lines[i + 1] || '';
    const snippet = lines[i].trim();
    const category = classify(lines[i], nextLine, prevLine);
    const contextHash = hashContext(`${prevLine}\n${lines[i]}\n${nextLine}`);
    const contextOrdinal = (contextCounts.get(contextHash) || 0) + 1;
    contextCounts.set(contextHash, contextOrdinal);
    records.push({
      file,
      line: i + 1,
      category,
      snippet,
      catchOrdinal,
      contextHash,
      contextOrdinal,
      key: `${file}:catch:${contextHash}:${contextOrdinal}`,
    });
  }

  return records;
}

function assertLineStableKeys() {
  const original = [
    'export function sample() {',
    '  try { return 1; }',
    '  catch {',
    '    return 2;',
    '  }',
    '}',
  ];
  const shifted = ['// unrelated insertion above the catch', ...original];
  const originalCatch = scanCatchRecordsInLines('synthetic.ts', original).find((record) => record.category === 'uncategorized');
  const shiftedCatch = scanCatchRecordsInLines('synthetic.ts', shifted).find((record) => record.category === 'uncategorized');
  assert(originalCatch && shiftedCatch, 'silent catch audit line-stability self-test must find synthetic catches');
  assert(
    originalCatch.key === shiftedCatch.key,
    `silent catch baseline key must be stable under unrelated line insertion: ${originalCatch.key} !== ${shiftedCatch.key}`,
  );
  assert(
    originalCatch.line !== shiftedCatch.line,
    'silent catch line-stability self-test must prove line number changed while identity remained stable',
  );
}

function sortRecords(recordsToSort) {
  return [...recordsToSort].sort((a, b) => a.key.localeCompare(b.key));
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
  assert(Array.isArray(data.uncategorizedCatchRecords), 'silent catch baseline must contain uncategorizedCatchRecords array with display metadata');
  assert(
    data.uncategorizedCatchRecords.every((record) => (
      record
      && typeof record.key === 'string'
      && typeof record.file === 'string'
      && Number.isInteger(record.line)
      && typeof record.snippet === 'string'
      && typeof record.contextHash === 'string'
      && Number.isInteger(record.contextOrdinal)
    )),
    'silent catch baseline records must include key/file/line/snippet/contextHash/contextOrdinal display metadata',
  );
  const unique = new Set(data.uncategorizedCatchKeys);
  assert(unique.size === data.uncategorizedCatchKeys.length, 'silent catch baseline contains duplicate keys');
  assert(
    data.uncategorizedCatchRecords.length === data.uncategorizedCatchKeys.length,
    'silent catch baseline record count must match key count',
  );
  const recordKeys = sortedUnique(data.uncategorizedCatchRecords.map((record) => record.key));
  assert(
    JSON.stringify(recordKeys) === JSON.stringify(sortedUnique(data.uncategorizedCatchKeys)),
    'silent catch baseline record keys must match uncategorizedCatchKeys',
  );
  return data;
}

function writeBaseline(recordsForBaseline) {
  const sortedRecords = sortRecords(recordsForBaseline);
  const keys = sortedRecords.map((record) => record.key);
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        version: BASELINE_VERSION,
        scanRoot: 'packages/main/src',
        policy: 'Existing uncategorized catch blocks are tracked as baseline debt; new line-stable uncategorized catch keys fail audit:silent-catches. Line numbers are display metadata only.',
        uncategorizedCatchKeys: keys,
        uncategorizedCatchRecords: sortedRecords.map((record) => ({
          key: record.key,
          file: record.file,
          line: record.line,
          snippet: record.snippet,
          catchOrdinal: record.catchOrdinal,
          contextHash: record.contextHash,
          contextOrdinal: record.contextOrdinal,
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

assertLineStableKeys();

const records = [];
for (const file of walk(scanRoot)) {
  const rel = relative(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  records.push(...scanCatchRecordsInLines(rel, lines));
}

const summary = Object.fromEntries(['DEBUG', 'PROBE', 'PERSIST', 'MUTATION', 'uncategorized'].map((key) => [key, 0]));
for (const record of records) summary[record.category] += 1;

const uncategorized = records.filter((record) => record.category === 'uncategorized');
const uncategorizedByKey = new Map(sortRecords(uncategorized).map((record) => [record.key, record]));
const currentUncategorizedKeys = sortedUnique(uncategorized.map((record) => record.key));

if (updateBaseline) {
  writeBaseline(uncategorized);
}

const baseline = loadBaseline();
const baselineKeys = new Set(baseline.uncategorizedCatchKeys);
const currentKeys = new Set(currentUncategorizedKeys);
const newUncategorizedKeys = currentUncategorizedKeys.filter((key) => !baselineKeys.has(key));
const resolvedBaselineKeys = baseline.uncategorizedCatchKeys.filter((key) => !currentKeys.has(key));
const baselineRecordsByKey = new Map(baseline.uncategorizedCatchRecords.map((record) => [record.key, record]));
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
  selfTests: {
    lineStableBaselineKey: 'passed',
  },
  newUncategorized: newUncategorizedKeys.slice(0, 50).map((key) => uncategorizedByKey.get(key) || { key }),
  resolvedBaselineDebt: resolvedBaselineKeys.slice(0, 50).map((key) => baselineRecordsByKey.get(key) || { key }),
  uncategorized: uncategorized.slice(0, 50),
};

console.log(JSON.stringify(output, null, 2));

if (newUncategorizedKeys.length > 0) {
  process.exitCode = 1;
}
