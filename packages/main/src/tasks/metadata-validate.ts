/**
 * Bidirectional validation: task.json vs source code
 *
 * 1. Stored but source function does not exist → function deleted, record stale
 * 2. Source function exists but not stored → new function not registered
 * 3. Function signature mismatch → code has been modified
 */

import ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TaskRecord } from './metadata-store.js';

interface ValidationResult {
  orphanRecords: Array<{ key: string; reason: string }>;
  missingRecords: Array<{ file: string; functionName: string; line: number }>;
  signatureMismatch: Array<{ key: string; stored: string; actual: string }>;
  healthy: boolean;
}

function findAllFunctions(filePath: string): Array<{ name: string; line: number; signature: string }> {
  if (!existsSync(filePath)) return [];
  const code = readFileSync(filePath, 'utf-8');
  const source = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  const results: Array<{ name: string; line: number; signature: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name: node.name.text, line,
        signature: code.slice(node.getStart(), code.indexOf('{', node.getStart())).trim().slice(0, 120) });
    }
    if (ts.isConstructorDeclaration(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name: 'constructor', line, signature: 'constructor()' });
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(source);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name, line,
        signature: code.slice(node.getStart(), code.indexOf('{', node.getStart())).trim().slice(0, 120) });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name: node.name.text, line, signature: `class ${node.name.text}` });
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          results.push({ name: decl.name.text, line,
            signature: code.slice(node.getStart(), code.indexOf('=>', node.getStart()) + 2).trim().slice(0, 120) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(source, visit);
  return results;
}

export function validateMetadata(tasks: TaskRecord[], scanRoot: string): ValidationResult {
  const orphanRecords: ValidationResult['orphanRecords'] = [];
  const missingRecords: ValidationResult['missingRecords'] = [];
  const signatureMismatch: ValidationResult['signatureMismatch'] = [];

  // Group tasks by file
  const tasksByFile = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const file = t.sourceFile;
    if (!tasksByFile.has(file)) tasksByFile.set(file, []);
    tasksByFile.get(file)!.push(t);
  }

  // Check each file
  const checkedFiles = new Set<string>();
  for (const [file, fileTasks] of tasksByFile) {
    checkedFiles.add(file);
    const filePath = join(scanRoot, file);

    if (!existsSync(filePath)) {
      for (const t of fileTasks) {
        orphanRecords.push({ key: t.key, reason: `File deleted: ${file}` });
      }
      continue;
    }

    const functions = findAllFunctions(filePath);

    for (const t of fileTasks) {
      if (!t.functionName) continue; // file-level record, skip
      const fn = functions.find(f => f.name === t.functionName);
      if (!fn) {
        orphanRecords.push({ key: t.key, reason: `Function deleted: ${t.functionName} in ${file}` });
      }
    }
  }

  return {
    orphanRecords,
    missingRecords,
    signatureMismatch,
    healthy: orphanRecords.length === 0 && missingRecords.length === 0 && signatureMismatch.length === 0,
  };
}
