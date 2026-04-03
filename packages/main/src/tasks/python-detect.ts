/**
 * Python 函数检测：通过 subprocess 调用 python ast 模块提取函数列表
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

export interface PythonFunction {
  name: string;
  line: number;
  signature: string;
  className?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', 'env']);

function walkPyFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...walkPyFiles(join(dir, entry.name)));
    } else if (extname(entry.name) === '.py') {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

/** 用 python ast 模块提取文件中的函数/方法定义 */
export function detectPythonFunctions(filePath: string): PythonFunction[] {
  if (!existsSync(filePath)) return [];

  const script = `
import ast, json, sys

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    tree = ast.parse(f.read())

results = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
        args = ', '.join(a.arg for a in node.args.args)
        # Check if inside a class
        class_name = None
        for parent in ast.walk(tree):
            if isinstance(parent, ast.ClassDef):
                for child in ast.iter_child_nodes(parent):
                    if child is node:
                        class_name = parent.name
                        break
        results.append({
            'name': node.name,
            'line': node.lineno,
            'signature': f"def {node.name}({args})",
            'className': class_name
        })
    elif isinstance(node, ast.ClassDef):
        results.append({
            'name': node.name,
            'line': node.lineno,
            'signature': f"class {node.name}",
            'className': None
        })

print(json.dumps(results))
`;

  try {
    const result = execSync(`python -c "${script.replace(/"/g, '\\"').replace(/\n/g, ';')}" "${filePath}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return JSON.parse(result.trim());
  } catch {
    // fallback: 正则匹配
    return detectPythonFunctionsRegex(filePath);
  }
}

/** 正则 fallback：匹配 def/class */
function detectPythonFunctionsRegex(filePath: string): PythonFunction[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: PythonFunction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // def function_name(args):
    const defMatch = line.match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)/);
    if (defMatch) {
      const indent = defMatch[1].length;
      const name = defMatch[2];
      const args = defMatch[3];
      // indent > 0 可能是 class method
      results.push({
        name,
        line: i + 1,
        signature: `def ${name}(${args})`,
      });
    }
    // class ClassName:
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      results.push({
        name: classMatch[1],
        line: i + 1,
        signature: `class ${classMatch[1]}`,
      });
    }
  }

  return results;
}

/** 扫描目录下所有 Python 文件的函数 */
export function scanPythonFunctions(scanRoot: string): Array<PythonFunction & { sourceFile: string }> {
  const files = walkPyFiles(scanRoot);
  const results: Array<PythonFunction & { sourceFile: string }> = [];

  for (const filePath of files) {
    const fns = detectPythonFunctions(filePath);
    const rel = relative(scanRoot, filePath);
    for (const fn of fns) {
      results.push({ ...fn, sourceFile: rel });
    }
  }

  return results;
}
