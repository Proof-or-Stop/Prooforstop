#!/usr/bin/env node
/**
 * 批量移除文件级 @task 块中的 @test 注释行
 *
 * 规则：如果 @test 所在的注释块紧跟的不是函数/方法定义（而是 import/require/'use strict'/class 等），
 * 则认为是文件级 @task，移除 @test 那一行。
 *
 * 用法: node scripts/remove-file-level-test.cjs <src-dir> [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!dir) {
  console.error('Usage: node scripts/remove-file-level-test.cjs <src-dir> [--dry-run]');
  process.exit(1);
}

function walkFiles(dir, exts) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...walkFiles(full, exts));
    } else if (exts.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const files = walkFiles(dir, ['.js', '.ts', '.tsx', '.mjs', '.cjs']);
let modified = 0;
let removed = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  // 找所有注释块
  let inBlock = false;
  let blockStart = -1;
  let testLineIdx = -1;
  const removals = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('/**')) {
      inBlock = true;
      blockStart = i;
      testLineIdx = -1;
    }

    if (inBlock && /^\*\s*@test\s+/.test(line)) {
      testLineIdx = i;
    }

    if (inBlock && line.endsWith('*/')) {
      inBlock = false;
      if (testLineIdx === -1) continue; // 没有 @test，跳过

      // 检查注释块后面第一行非空内容
      let nextContentLine = '';
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const next = lines[j].trim();
        if (next) {
          nextContentLine = next;
          break;
        }
      }

      // 判断是否是文件级：后面不是函数/方法定义
      const isFunctionNext =
        /^(export\s+)?(default\s+)?(async\s+)?function\s+/.test(nextContentLine) ||
        /^(export\s+)?(const|let|var)\s+\w+\s*=/.test(nextContentLine) ||
        /^(public|private|protected|static|async|\w+)\s*\(/.test(nextContentLine);

      if (!isFunctionNext) {
        removals.push(testLineIdx);
      }
    }
  }

  if (removals.length > 0) {
    const relPath = path.relative(dir, file);
    for (const lineIdx of removals) {
      console.log(`${dryRun ? '[dry-run] ' : ''}${relPath}:${lineIdx + 1}  ${lines[lineIdx].trim()}`);
      removed++;
    }

    if (!dryRun) {
      const newLines = lines.filter((_, i) => !removals.includes(i));
      fs.writeFileSync(file, newLines.join('\n'));
    }
    modified++;
  }
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}${modified} files, ${removed} @test lines removed`);
