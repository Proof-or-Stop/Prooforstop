
import { execSync } from 'child_process';
import { relative, join } from 'path';
import type { TaskAnnotation } from './types.js';

export interface DiffFunction {
  file: string;       // relative to scanRoot
  functionName: string;
  line: number;
}

export interface DriftItem {
  file: string;
  functionName: string;
  line: number;
  reason: string;     // 'no-annotation' | 'annotation-stale'
}

export interface DriftResult {
  base: string;
  diffFunctions: DiffFunction[];
  drifts: DriftItem[];
  passed: boolean;
}

export function parseDiffFunctions(root: string, scanRoot: string, base = 'HEAD'): DiffFunction[] {
  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff ${base} --unified=0 --no-color -- "${scanRoot}"`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    return [];
  }

  if (!diffOutput.trim()) return [];

  const results: DiffFunction[] = [];
  const seen = new Set<string>();
  let currentFile: string | null = null;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6); // strip '+++ b/'
      continue;
    }

    if (line.startsWith('@@') && currentFile) {
      if (!/\.(ts|tsx|js|jsx)$/.test(currentFile)) continue;

      const hunkMatch = line.match(/@@ [^@]+ @@\s*(.*)/);
      const funcContext = hunkMatch?.[1]?.trim();

      const lineMatch = line.match(/\+(\d+)/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 0;

      if (funcContext) {
        const fnName = extractFunctionName(funcContext);
        if (fnName) {
          // currentFile 是 git 相对路径，转为相对 scanRoot 的路径
          const absFile = join(root, currentFile);
          const relFile = relative(scanRoot, absFile);
          const key = `${relFile}:${fnName}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ file: relFile, functionName: fnName, line: lineNum });
          }
        }
      }
    }
  }

  return results;
}

/** Extract function/method/class name from git diff hunk context line */
function extractFunctionName(context: string): string | null {
  const fnMatch = context.match(/(?:async\s+)?function\s+(\w+)/);
  if (fnMatch) return fnMatch[1];

  const constMatch = context.match(/(?:const|let|var)\s+(\w+)\s*=/);
  if (constMatch) return constMatch[1];

  const classMatch = context.match(/class\s+(\w+)/);
  if (classMatch) return classMatch[1];

  const methodMatch = context.match(/(?:public|private|protected|static|async|\s)*(\w+)\s*\(/);
  if (methodMatch) {
    const name = methodMatch[1];
    if (!['if', 'for', 'while', 'switch', 'return', 'import', 'export', 'new', 'throw', 'catch', 'typeof', 'tool', 'use', 'app', 'server', 'router'].includes(name)) {
      return name;
    }
  }

  return null;
}

export function checkDrift(
  diffFunctions: DiffFunction[],
  annotations: TaskAnnotation[],
): DriftItem[] {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const annotated = new Set<string>();
  const fileLevel = new Set<string>();
  for (const a of annotations) {
    if (a.functionName) {
      annotated.add(`${norm(a.sourceFile)}:${a.functionName}`);
    } else {
      fileLevel.add(norm(a.sourceFile));
    }
  }

  const drifts: DriftItem[] = [];
  for (const df of diffFunctions) {
    const key = `${norm(df.file)}:${df.functionName}`;
    if (!annotated.has(key) && !fileLevel.has(norm(df.file))) {
      drifts.push({
        file: df.file,
        functionName: df.functionName,
        line: df.line,
        reason: 'no-annotation',
      });
    }
  }

  return drifts;
}
