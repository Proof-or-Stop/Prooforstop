
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
    // --- a/packages/main/src/foo.ts or +++ b/packages/main/src/foo.ts
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6); // strip '+++ b/'
      continue;
    }

    // @@ -oldStart[,oldCount] +newStart[,newCount] @@ [functionContext]
    if (line.startsWith('@@') && currentFile) {
      // Only care about .ts/.tsx/.js/.jsx files
      if (!/\.(ts|tsx|js|jsx)$/.test(currentFile)) continue;

      const hunkMatch = line.match(/@@ [^@]+ @@\s*(.*)/);
      const funcContext = hunkMatch?.[1]?.trim();

      // Extract line number from hunk header
      const lineMatch = line.match(/\+(\d+)/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 0;

      // Try to extract function name from the context after @@
      if (funcContext) {
        const fnName = extractFunctionName(funcContext);
        if (fnName) {
          // currentFile 是 git 相对路径（如 packages/game/src/x.ts），需要先转绝对路径
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
  // function declarations
  const fnMatch = context.match(/(?:async\s+)?function\s+(\w+)/);
  if (fnMatch) return fnMatch[1];

  // const/let/var arrow or function expression
  const constMatch = context.match(/(?:const|let|var)\s+(\w+)\s*=/);
  if (constMatch) return constMatch[1];

  // class declaration
  const classMatch = context.match(/class\s+(\w+)/);
  if (classMatch) return classMatch[1];

  // method: [modifier] name(
  const methodMatch = context.match(/(?:public|private|protected|static|async|\s)*(\w+)\s*\(/);
  if (methodMatch) {
    const name = methodMatch[1];
    if (!['if', 'for', 'while', 'switch', 'return', 'import', 'export', 'new', 'throw', 'catch', 'typeof'].includes(name)) {
      return name;
    }
  }

  return null;
}

export function checkDrift(
  diffFunctions: DiffFunction[],
  annotations: TaskAnnotation[],
): DriftItem[] {
  // Build a set of annotated functions (file:functionName)
  const annotated = new Set<string>();
  for (const a of annotations) {
    if (a.functionName) {
      annotated.add(`${a.sourceFile}:${a.functionName}`);
    }
  }

  const drifts: DriftItem[] = [];
  for (const df of diffFunctions) {
    const key = `${df.file}:${df.functionName}`;
    if (!annotated.has(key)) {
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
