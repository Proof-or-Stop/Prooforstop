
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import type { TaskAnnotation, ExtractFilters, FlowStep, FlowChain } from './types.js';
import { loadConfig, hasProjectConfigFile } from '../core/config.js';

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs',
  '.py', '.go', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.rs', '.rb',
]);
/**
 * B-b9d0 CHK-003: derived runtime directories are anchored by exact directory
 * name and skipped during walk. `.build` covers SwiftPM derived trees whose
 * GRDB CustomSQLite checkouts contain symlink loops; the other entries match
 * common toolchain output trees. `.worktrees` is excluded because nested
 * worktrees of the same repo would otherwise be re-scanned recursively.
 * docs/story and docs/requirements are NOT in this list — convergence must
 * keep seeing real metadata drift.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.build',
  '.next', '.turbo', '.cache', '.svelte-kit', '.parcel-cache',
  '__pycache__',
  '.worktrees',
]);

export function shouldSkipSourceDir(entry: string): boolean {
  return SKIP_DIRS.has(entry);
}

const SINGLE_FIELDS = new Set([
  'task', 'checklist', 'title', 'type', 'priority', 'version',
  'scope', 'depends', 'author', 'date',
  'flow', 'step', 'input', 'output', 'next', 'test',
]);
const MULTI_FIELDS = new Set(['description', 'changes', 'affected']);

/** 递归遍历目录，收集常见语言源码文件 */
export function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // B-b9d0 CHK-003: permission errors or transient races on derived trees
    // (e.g. .build/checkouts swap targets) must not crash the gap scanner.
    return results;
  }
  for (const entry of entries) {
    if (shouldSkipSourceDir(entry)) continue;
    const full = join(dir, entry);
    // B-b9d0 CHK-003: use lstatSync so we see the symlink itself rather than
    // its (potentially looping) target. SwiftPM .build/checkouts ships with
    // self-referential symlink trees (GRDB CustomSQLite) that would otherwise
    // raise ELOOP and crash convergence_check.
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      try {
        results.push(...walkDir(full));
      } catch {
        // Defensive: any unexpected error from a deeply nested derived tree
        // is treated as "no annotations to collect" rather than aborting the
        // whole scan.
      }
    } else if (CODE_EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

export function extractBlocks(content: string): Array<{ raw: string; line: number; endIndex: number }> {
  const blocks: Array<{ raw: string; line: number; endIndex: number }> = [];
  const blockPatterns = [
    /\/\*\*[\s\S]*?\*\//g,
    /("""[\s\S]*?"""|'''[\s\S]*?''')/g,
  ];
  for (const regex of blockPatterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const block = match[0];
      if (!block.includes('@task')) continue;
      const line = content.slice(0, match.index).split('\n').length;
      blocks.push({ raw: block, line, endIndex: match.index + block.length });
    }
  }

  const lineBlockRegex = /(^[ \t]*(?:\/\/|#)[^\n]*(?:\n[ \t]*(?:\/\/|#)[^\n]*)*)/gm;
  let match: RegExpExecArray | null;
  while ((match = lineBlockRegex.exec(content)) !== null) {
    const block = match[0];
    if (!block.includes('@task')) continue;
    const line = content.slice(0, match.index).split('\n').length;
    blocks.push({ raw: block, line, endIndex: match.index + block.length });
  }
  return blocks.sort((a, b) => a.line - b.line);
}

export function parseFunctionAfterBlock(
  content: string,
  endIndex: number,
): { functionName: string; functionSignature: string } | null {
  // Take code after the comment block, skip blank lines / decorators
  const after = content.slice(endIndex);
  // Match the first non-empty, non-decorator line(s) — grab up to 500 chars for multi-line sigs
  const snippet = after.slice(0, 500);

  // Pattern 1: function declaration
  //   [export] [default] [async] function NAME(...)
  const fnMatch = snippet.match(
    /^[\s\n]*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)\s*(\([^)]*\))/,
  );
  if (fnMatch) {
    const prefix = [fnMatch[1], fnMatch[2], fnMatch[3]].filter(Boolean).map(s => s.trim()).join(' ');
    const name = fnMatch[4];
    const params = fnMatch[5];
    const sig = `${prefix ? prefix + ' ' : ''}function ${name}${params}`.replace(/\s+/g, ' ').trim();
    return { functionName: name, functionSignature: sig };
  }

  // Pattern 2: const/let/var arrow function or function expression
  //   [export] const NAME = [async] (...) => | [async] function(...)
  const constMatch = snippet.match(
    /^[\s\n]*(export\s+)?(const|let|var)\s+(\w+)\s*(?::\s*[^=]+?)?\s*=\s*(async\s+)?(?:(\([^)]*\))\s*(?::\s*[^=]+?)?\s*=>|function\s*(\([^)]*\)))/,
  );
  if (constMatch) {
    const exportPrefix = constMatch[1] ? 'export ' : '';
    const keyword = constMatch[2];
    const name = constMatch[3];
    const asyncPrefix = constMatch[4] ? 'async ' : '';
    const params = constMatch[5] || constMatch[6];
    const sig = `${exportPrefix}${keyword} ${name} = ${asyncPrefix}${params} =>`.replace(/\s+/g, ' ').trim();
    return { functionName: name, functionSignature: sig };
  }

  // Pattern 3: class declaration
  //   [export] [default] [abstract] class NAME
  const classMatch = snippet.match(
    /^[\s\n]*(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/,
  );
  if (classMatch) {
    const prefix = [classMatch[1], classMatch[2], classMatch[3]].filter(Boolean).map(s => s.trim()).join(' ');
    const name = classMatch[4];
    const sig = `${prefix ? prefix + ' ' : ''}class ${name}`.replace(/\s+/g, ' ').trim();
    return { functionName: name, functionSignature: sig };
  }

  // Pattern 4: class method (when @task is inside a class body)
  //   [public|private|protected] [static] [async] NAME(...)
  const methodMatch = snippet.match(
    /^[\s\n]*(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\w+)\s*(\([^)]*\))/,
  );
  if (methodMatch) {
    const name = methodMatch[4];
    // Skip if name is a keyword that doesn't indicate a real method
    if (['import', 'return', 'if', 'else', 'for', 'while', 'switch', 'throw', 'new', 'const', 'let', 'var', 'type', 'interface', 'enum'].includes(name)) {
      return null;
    }
    const prefix = [methodMatch[1], methodMatch[2], methodMatch[3]].filter(Boolean).map(s => s.trim()).join(' ');
    const params = methodMatch[5];
    const sig = `${prefix ? prefix + ' ' : ''}${name}${params}`.replace(/\s+/g, ' ').trim();
    return { functionName: name, functionSignature: sig };
  }

  const pythonMatch = snippet.match(/^[\s\n]*(async\s+)?def\s+(\w+)\s*(\([^)]*\))/);
  if (pythonMatch) {
    const prefix = pythonMatch[1] || '';
    const name = pythonMatch[2];
    const params = pythonMatch[3];
    return { functionName: name, functionSignature: `${prefix}def ${name}${params}`.replace(/\s+/g, ' ').trim() };
  }

  const goMatch = snippet.match(/^[\s\n]*func\s+(?:\([^)]*\)\s*)?(\w+)\s*(\([^)]*\))/);
  if (goMatch) {
    const name = goMatch[1];
    return { functionName: name, functionSignature: `func ${name}${goMatch[2]}`.replace(/\s+/g, ' ').trim() };
  }

  const swiftMatch = snippet.match(/^[\s\n]*(?:public\s+|private\s+|internal\s+|fileprivate\s+|static\s+|class\s+|mutating\s+)*func\s+(\w+)\s*(\([^)]*\))/);
  if (swiftMatch) {
    const name = swiftMatch[1];
    return { functionName: name, functionSignature: `func ${name}${swiftMatch[2]}`.replace(/\s+/g, ' ').trim() };
  }

  const javaLikeMatch = snippet.match(/^[\s\n]*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|override\s+|virtual\s+|inline\s+|constexpr\s+)*[\w:<>,~*&\s]+\s+(\w+)\s*(\([^)]*\))/);
  if (javaLikeMatch) {
    const name = javaLikeMatch[1];
    if (!['if', 'for', 'while', 'switch', 'return', 'catch'].includes(name)) {
      return { functionName: name, functionSignature: snippet.slice(0, snippet.indexOf(')') + 1).replace(/\s+/g, ' ').trim() };
    }
  }

  return null;
}

/** 解析单个注释块为结构化对象 */
export function parseBlock(raw: string): Record<string, string | string[]> {
  const normalized = raw
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .replace(/^(?:"""|''')\s*/, '')
    .replace(/\s*(?:"""|''')$/, '');
  const lines = normalized
    .split('\n')
    .map(l => l.replace(/^\s*(?:\*|\/\/|#)\s?/, ''));

  const result: Record<string, string | string[]> = {};
  let currentField: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (!currentField) return;
    if (MULTI_FIELDS.has(currentField)) {
      result[currentField] = currentLines
        .map(l => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
      if (currentField === 'description') {
        result[currentField] = (result[currentField] as string[]).join('\n');
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
      currentField = tagMatch[1];
      const value = tagMatch[2].trim();
      currentLines = value ? [value] : [];
    } else if (currentField) {
      currentLines.push(line);
    }
  }
  flush();

  // depends / checklist 拆分为数组
  if (typeof result.depends === 'string') {
    result.depends = result.depends.split(/[,;]\s*/).filter(Boolean);
  }
  if (typeof result.checklist === 'string') {
    result.checklist = result.checklist.split(/[,;]\s*/).filter(Boolean);
  }

  return result;
}

export function scan(scanRoot: string): TaskAnnotation[] {
  // 优先从 metadata store（task.json）读取，不再扫描源码
  // 从 scanRoot 向上查找 proof-or-stop.config.json 确定项目根，再定位 docs/metadata/task.json
  let metadataPath = '';
  let searchDir = scanRoot;
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(searchDir)) {
      const candidate = join(searchDir, 'docs', 'metadata', 'task.json');
      if (existsSync(candidate)) metadataPath = candidate;
      break;
    }
    const parent = join(searchDir, '..');
    if (parent === searchDir) break;
    searchDir = parent;
  }
  if (metadataPath) {
    try {
      const store = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      if (store.tasks && store.tasks.length > 0) {
        const projectRoot = dirname(dirname(dirname(metadataPath))); // docs/metadata/task.json → root
        const config = loadConfig(projectRoot);
        const sr = join(projectRoot, config.scanRoot);

        return store.tasks.map((t: any) => {
          // functionSignature 缺失时从源码正则提取
          let sig = t.functionSignature || '';
          if (!sig && t.sourceFile && t.functionName) {
            try {
              const filePath = join(sr, t.sourceFile);
              if (existsSync(filePath)) {
                const code = readFileSync(filePath, 'utf-8');
                const name = t.functionName;
                // 匹配: [export] [async] function name(...) / name(...) { / name = (...) =>
                const patterns = [
                  new RegExp(`((?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)[^{]*)\\{`),
                  new RegExp(`((?:static\\s+)?(?:async\\s+)?${name}\\s*\\([^)]*\\)[^{]*)\\{`),
                  new RegExp(`((?:export\\s+)?(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)[^=]*=>)`),
                  new RegExp(`(export\\s+class\\s+${name}[^{]*)\\{`),
                ];
                for (const p of patterns) {
                  const m = code.match(p);
                  if (m) { sig = m[1].trim().slice(0, 120); break; }
                }
              }
            } catch {}
          }
          return {
            task: t.task,
            checklist: t.checklist,
            title: t.title,
            type: t.type,
            priority: t.priority,
            version: t.version,
            scope: t.scope,
            depends: t.depends,
            author: t.author,
            date: t.date,
            description: t.description,
            changes: t.changes,
            affected: t.affected,
            sourceFile: t.sourceFile,
            sourceLine: t.sourceLine,
            functionName: t.functionName,
            functionSignature: sig || undefined,
            flow: t.flow?.name,
            step: t.flow?.step,
            input: t.flow?.input,
            output: t.flow?.output,
            next: t.flow?.next,
            test: t.test,
          } as TaskAnnotation;
        });
      }
    } catch { /* fallback to source scan */ }
  }

  // Fallback: 扫描源码（兼容未迁移的项目）
  const files = walkDir(scanRoot);
  const tasks: TaskAnnotation[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const blocks = extractBlocks(content);

    for (const { raw, line, endIndex } of blocks) {
      const parsed = parseBlock(raw);
      if (!parsed.task) continue;
      const fnInfo = parseFunctionAfterBlock(content, endIndex);
      tasks.push({
        ...parsed,
        task: parsed.task as string,
        checklist: parsed.checklist as string[] | undefined,
        title: parsed.title as string | undefined,
        type: parsed.type as string | undefined,
        priority: parsed.priority as string | undefined,
        version: parsed.version as string | undefined,
        scope: parsed.scope as string | undefined,
        depends: parsed.depends as string[] | undefined,
        author: parsed.author as string | undefined,
        date: parsed.date as string | undefined,
        description: parsed.description as string | undefined,
        changes: parsed.changes as string[] | undefined,
        affected: parsed.affected as string[] | undefined,
        sourceFile: relative(scanRoot, filePath),
        sourceLine: line,
        functionName: fnInfo?.functionName,
        functionSignature: fnInfo?.functionSignature,
        flow: parsed.flow as string | undefined,
        step: parsed.step ? parseInt(parsed.step as string, 10) : undefined,
        input: parsed.input as string | undefined,
        output: parsed.output as string | undefined,
        next: parsed.next as string | undefined,
        test: parsed.test as string | undefined,
      });
    }
  }

  return tasks;
}

/** 按条件筛选 */
export function filterTasks(tasks: TaskAnnotation[], filters: ExtractFilters): TaskAnnotation[] {
  return tasks.filter(t => {
    if (filters.type && t.type !== filters.type) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.version && t.version !== filters.version) return false;
    if (filters.id && t.task !== filters.id) return false;
    return true;
  });
}

export function extractFlows(tasks: TaskAnnotation[]): FlowChain[] {
  const flowMap = new Map<string, FlowStep[]>();

  for (const t of tasks) {
    if (!t.flow || t.step === undefined || !t.functionName) continue;
    const step: FlowStep = {
      flow: t.flow,
      step: t.step,
      input: t.input,
      output: t.output,
      next: t.next,
      functionName: t.functionName,
      functionSignature: t.functionSignature,
      sourceFile: t.sourceFile,
      sourceLine: t.sourceLine,
      task: t.task,
    };
    if (!flowMap.has(t.flow)) {
      flowMap.set(t.flow, []);
    }
    flowMap.get(t.flow)!.push(step);
  }

  const chains: FlowChain[] = [];
  for (const [name, steps] of flowMap) {
    steps.sort((a, b) => a.step - b.step);
    // A flow is complete if steps are 1..N with no gaps and last step has no @next
    const isComplete = steps.length > 0
      && steps[0].step === 1
      && steps.every((s, i) => s.step === i + 1)
      && !steps[steps.length - 1].next;
    chains.push({ name, steps, complete: isComplete });
  }

  return chains;
}

/** 转换为 Markdown 报告 */
export function toMarkdown(tasks: TaskAnnotation[]): string {
  if (tasks.length === 0) return '> No tasks found.\n';

  const lines = [`# Task Report`, ``, `> ${tasks.length} task(s) found`, ``];

  for (const t of tasks) {
    lines.push(`## ${t.task}: ${t.title || 'Untitled'}`);
    lines.push(``);

    const meta: string[] = [];
    if (t.type) meta.push(`**Type:** ${t.type}`);
    if (t.priority) meta.push(`**Priority:** ${t.priority}`);
    if (t.version) meta.push(`**Version:** ${t.version}`);
    if (t.scope) meta.push(`**Scope:** ${t.scope}`);
    if (t.author) meta.push(`**Author:** ${t.author}`);
    if (t.date) meta.push(`**Date:** ${t.date}`);
    if (t.checklist) meta.push(`**Checklist:** ${t.checklist.join(', ')}`);
    if (t.depends) meta.push(`**Depends:** ${t.depends.join(', ')}`);
    if (t.functionName) meta.push(`**Function:** \`${t.functionName}\``);
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
