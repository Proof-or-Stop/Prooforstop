#!/usr/bin/env node
/**
 * 独立迁移脚本：从源码注释提取元数据到 JSON + 删除源码注释
 *
 * 用法:
 *   node scripts/migrate-annotations.cjs <project-root> [--extract-only] [--clean-only] [--dry-run]
 *
 * 步骤:
 *   1. extract: 扫描 scanRoot 下所有 @task 注释 → 写入 docs/metadata/task.json + flow.json
 *   2. clean: 删除源码中的 @task 注释块
 *
 * 需要项目有 koala.config.json（读取 scanRoot）
 * 也可在其他项目中使用：拷贝此脚本，配置 scanRoot 即可
 */

const fs = require('fs');
const path = require('path');

const projectRoot = process.argv[2];
const extractOnly = process.argv.includes('--extract-only');
const cleanOnly = process.argv.includes('--clean-only');
const dryRun = process.argv.includes('--dry-run');

if (!projectRoot) {
  console.error('Usage: node scripts/migrate-annotations.cjs <project-root> [--extract-only] [--clean-only] [--dry-run]');
  process.exit(1);
}

// ── Config ──

let scanRoot = 'src';
const configPath = path.join(projectRoot, 'koala.config.json');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    scanRoot = config.scanRoot || 'src';
  } catch {}
}
const fullScanRoot = path.join(projectRoot, scanRoot);
const metadataDir = path.join(projectRoot, 'docs', 'metadata');

console.log(`Project: ${projectRoot}`);
console.log(`Scan root: ${fullScanRoot}`);
console.log(`Metadata dir: ${metadataDir}`);
if (dryRun) console.log('[DRY RUN]');

// ── Helpers ──

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...walkDir(path.join(dir, entry.name)));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function extractBlocks(content) {
  const blocks = [];
  const regex = /\/\*\*[\s\S]*?\*\//g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (/@task\s/.test(match[0])) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      blocks.push({
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        line,
      });
    }
  }
  return blocks;
}

function parseBlock(raw) {
  const result = {};
  const lines = raw.split('\n');
  let currentField = null;
  let currentValue = [];

  const SINGLE_FIELDS = new Set([
    'task', 'checklist', 'title', 'type', 'priority', 'version',
    'scope', 'depends', 'author', 'date',
    'flow', 'step', 'input', 'output', 'next', 'test',
  ]);
  const MULTI_FIELDS = new Set(['description', 'changes', 'affected']);

  for (const line of lines) {
    const cleaned = line.replace(/^\s*\*?\s?/, '').trim();
    if (cleaned === '/**' || cleaned === '*/') continue;

    const fieldMatch = cleaned.match(/^@(\w+)\s*(.*)/);
    if (fieldMatch) {
      if (currentField && MULTI_FIELDS.has(currentField)) {
        result[currentField] = currentValue;
      }
      currentField = fieldMatch[1];
      const value = fieldMatch[2].trim();
      if (SINGLE_FIELDS.has(currentField)) {
        result[currentField] = value || undefined;
        currentField = null;
        currentValue = [];
      } else {
        currentValue = value ? [value] : [];
      }
    } else if (currentField && MULTI_FIELDS.has(currentField) && cleaned) {
      currentValue.push(cleaned);
    }
  }
  if (currentField && MULTI_FIELDS.has(currentField)) {
    result[currentField] = currentValue;
  }

  if (typeof result.depends === 'string') {
    result.depends = result.depends.split(/[,;]\s*/).filter(Boolean);
  }
  if (typeof result.checklist === 'string') {
    result.checklist = result.checklist.split(/[,;]\s*/).filter(Boolean);
  }

  return result;
}

function parseFunctionAfterBlock(content, endIndex) {
  const snippet = content.slice(endIndex, endIndex + 500);
  // function declaration
  const fnMatch = snippet.match(/^[\s\n]*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
  if (fnMatch) return { functionName: fnMatch[4], functionSignature: fnMatch[0].trim().slice(0, 120) };
  // const/let/var arrow
  const constMatch = snippet.match(/^[\s\n]*(export\s+)?(const|let|var)\s+(\w+)\s*(?::[^=]+?)?\s*=\s*(async\s+)?(?:(\([^)]*\))\s*(?::[^=]+?)?\s*=>|function\s*(\([^)]*\)))/);
  if (constMatch) return { functionName: constMatch[3], functionSignature: constMatch[0].trim().slice(0, 120) };
  // class
  const classMatch = snippet.match(/^[\s\n]*(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/);
  if (classMatch) return { functionName: classMatch[4], functionSignature: `class ${classMatch[4]}` };
  // method
  const methodMatch = snippet.match(/^[\s\n]*(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\w+)\s*(\([^)]*\))/);
  if (methodMatch) {
    const name = methodMatch[4];
    const skip = ['import', 'return', 'if', 'else', 'for', 'while', 'switch', 'throw', 'new', 'const', 'let', 'var', 'type', 'interface', 'enum'];
    if (skip.includes(name)) return null;
    return { functionName: name, functionSignature: `${name}(...)` };
  }
  return null;
}

// ── Extract ──

function doExtract() {
  console.log('\n[1/2] Extracting annotations...');
  const files = walkDir(fullScanRoot);
  const tasks = [];
  const flowSteps = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = extractBlocks(content);
    const rel = path.relative(fullScanRoot, filePath);

    for (const block of blocks) {
      const parsed = parseBlock(block.raw);
      if (!parsed.task) continue;
      const fnInfo = parseFunctionAfterBlock(content, block.endIndex);

      const key = fnInfo?.functionName ? `${rel}:${fnInfo.functionName}` : rel;
      const record = {
        key,
        task: parsed.task,
        checklist: parsed.checklist,
        title: parsed.title,
        type: parsed.type,
        priority: parsed.priority,
        version: parsed.version,
        scope: parsed.scope,
        depends: parsed.depends,
        author: parsed.author,
        date: parsed.date,
        description: Array.isArray(parsed.description) ? parsed.description.join('\n') : parsed.description,
        changes: parsed.changes,
        affected: parsed.affected,
        sourceFile: rel,
        sourceLine: block.line,
        functionName: fnInfo?.functionName,
        functionSignature: fnInfo?.functionSignature,
        test: parsed.test,
      };

      if (parsed.flow) {
        record.flow = {
          name: parsed.flow,
          step: parseInt(parsed.step, 10),
          input: parsed.input,
          output: parsed.output,
          next: parsed.next,
        };
        flowSteps.push({
          flow: parsed.flow,
          step: parseInt(parsed.step, 10),
          functionName: fnInfo?.functionName || 'unknown',
          functionSignature: fnInfo?.functionSignature,
          sourceFile: rel,
          sourceLine: block.line,
          task: parsed.task,
          input: parsed.input,
          output: parsed.output,
          next: parsed.next,
        });
      }

      tasks.push(record);
    }
  }

  // Build flows
  const flowMap = new Map();
  for (const step of flowSteps) {
    if (!flowMap.has(step.flow)) flowMap.set(step.flow, []);
    flowMap.get(step.flow).push(step);
  }
  const flows = [];
  for (const [name, steps] of flowMap) {
    steps.sort((a, b) => a.step - b.step);
    flows.push({ name, steps, complete: true });
  }

  if (!dryRun) {
    if (!fs.existsSync(metadataDir)) fs.mkdirSync(metadataDir, { recursive: true });
    fs.writeFileSync(
      path.join(metadataDir, 'task.json'),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(metadataDir, 'flow.json'),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), flows }, null, 2) + '\n'
    );
  }

  console.log(`  ${tasks.length} tasks extracted`);
  console.log(`  ${flows.length} flows extracted`);
  console.log(`  → ${metadataDir}/task.json`);
  console.log(`  → ${metadataDir}/flow.json`);
  return { tasks, flows };
}

// ── Clean ──

function doClean() {
  console.log('\n[2/2] Cleaning source annotations...');
  const files = walkDir(fullScanRoot);
  let totalBlocks = 0;
  let totalFiles = 0;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = extractBlocks(content);
    if (blocks.length === 0) continue;

    const lines = content.split('\n');
    // 收集每个注释块的行范围
    const ranges = [];
    for (const block of blocks) {
      const startLine = content.slice(0, block.startIndex).split('\n').length - 1;
      const endLine = startLine + block.raw.split('\n').length - 1;
      ranges.push({ start: startLine, end: endLine });
    }

    // 从后往前删
    ranges.sort((a, b) => b.start - a.start);
    const newLines = [...lines];
    for (const range of ranges) {
      newLines.splice(range.start, range.end - range.start + 1);
      totalBlocks++;
    }

    const cleaned = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
    const rel = path.relative(fullScanRoot, filePath);

    if (dryRun) {
      console.log(`  [dry-run] ${rel}: ${ranges.length} blocks`);
    } else {
      fs.writeFileSync(filePath, cleaned);
    }
    totalFiles++;
  }

  console.log(`  ${totalBlocks} blocks removed from ${totalFiles} files`);
}

// ── Main ──

if (!cleanOnly) doExtract();
if (!extractOnly) doClean();

console.log('\nDone.');
