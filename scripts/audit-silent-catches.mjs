#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

const root = process.cwd();
const scanRoot = join(root, 'packages', 'main', 'src');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const CATEGORIES = ['DEBUG', 'PROBE', 'PERSIST', 'MUTATION'];

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

const output = {
  total: records.length,
  summary,
  uncategorized: records.filter((record) => record.category === 'uncategorized').slice(0, 50),
};

console.log(JSON.stringify(output, null, 2));
