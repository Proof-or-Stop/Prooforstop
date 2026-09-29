import assert from 'node:assert/strict';


import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';


import { join, relative, resolve } from 'node:path';

import ts from 'typescript';


import { legacyQuarantineFiles, explicitLegacyTaskQuarantineFiles, structuralLegacyFieldQuarantineFiles, renderedLegacyFieldPattern, quotedLegacyFieldLinePattern, bareLegacyFieldLinePattern, fieldShapePattern, propertyDeclarationPattern, propertyAssignmentPattern, objectMemberPattern, bracketMemberPattern, callArgumentPattern, repoRoot } from "./rule-data.js";

export function fileIsExplicitLegacyQuarantine(file: string): boolean {
  return legacyQuarantineFiles.has(file) || explicitLegacyTaskQuarantineFiles.has(file);
}

export function lineIsStructuralLegacyFieldQuarantine(file: string, line: string): boolean {
  if (!structuralLegacyFieldQuarantineFiles.has(file)) return false;
  if (renderedLegacyFieldPattern.test(line)) return false;
  return quotedLegacyFieldLinePattern.test(line)
    || bareLegacyFieldLinePattern.test(line)
    || fieldShapePattern.test(line)
    || propertyDeclarationPattern.test(line)
    || propertyAssignmentPattern.test(line)
    || objectMemberPattern.test(line)
    || bracketMemberPattern.test(line)
    || callArgumentPattern.test(line);
}

export function readRel(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

export function listFilesFromRoot(
  scanRoot: string,
  dir: string,
  extensions: readonly string[],
  visitedDirectories = new Set<string>(),
): string[] {
  const abs = resolve(scanRoot, dir);
  const relDir = relative(scanRoot, abs).replace(/\\/g, '/');
  if (relDir === '..' || relDir.startsWith('../') || !existsSync(abs)) return [];
  const rootStat = lstatSync(abs);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  const directoryKey = relDir || '.';
  if (visitedDirectories.has(directoryKey)) return [];
  visitedDirectories.add(directoryKey);
  const found: string[] = [];
  for (const entry of readdirSync(abs).sort()) {
    const full = join(abs, entry);
    const rel = relative(scanRoot, full).replace(/\\/g, '/');
    if (rel.split('/').includes('.omx')) continue;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      found.push(...listFilesFromRoot(scanRoot, rel, extensions, visitedDirectories));
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      found.push(rel);
    }
  }
  return found;
}

export function listFiles(dir: string, extensions: readonly string[]): string[] {
  return listFilesFromRoot(repoRoot, dir, extensions);
}

export function lineIsQuarantined(file: string, line: string): boolean {
  if (file === '<positive-control>') return false;
  if (fileIsExplicitLegacyQuarantine(file)) return true;
  if (line.includes('@help-hidden')) return true;
  if (line.includes('HIDDEN_LOCAL_ASSURANCE_REFUSAL')) return true;
  if (/legacy .*compatibility|retired compatibility|legacy quarantine|legacy retired|retired .*alias/i.test(line)) return true;
  if (file.includes('/dist/')) return true;
  if (/^\s*\*.*(?:legacy|retired|compatibility|quarantine)/i.test(line)) return true;
  if (/\brejected\.push\(['"`](authorityDone|fullAuthorityDone|productionDone)=true['"`]\)/.test(line)) return true;
  if (lineIsStructuralLegacyFieldQuarantine(file, line)) return true;
  return false;
}

export function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

export type ModuleReferenceKind = 'import' | 'export' | 'dynamic-import' | 'require';

export interface ModuleReference {
  specifier: string;
  index: number;
  kind: ModuleReferenceKind;
}

export const parsedSourceCache = new Map<string, { text: string; source: ts.SourceFile }>();

export interface SourceTypeAnalysis {
  program: ts.Program;
  source: ts.SourceFile;
  checker: ts.TypeChecker;
}
