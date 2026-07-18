/**
 * @task B-6bfd
 * @checklist CHK-002
 * @title Mechanical scope diff pack
 * @type feature
 * @priority high
 * @description
 *   Builds a compact, deterministic diff context pack for semantic scope
 *   review. The pack is a reviewer input, not a new truth source.
 * @changes
 *   - [CHK-002] Add diffPackHash, changed files, hunks, anchors, key paths, and parseFallback.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { ScopeDiffHunk, ScopeDiffPack } from './types.js';
import { readChangedFiles } from './scope-contract.js';
import { loadConfig } from './config.js';

export const SCOPE_ANCHOR_PARSER_VERSION = `typescript-${ts.versionMajorMinor}-ast-v1` as const;
export const SCOPE_ANCHOR_ARTIFACT_VERSION = 'lattice.scope-anchor.v1' as const;

export function digestScopeDiffPack(pack: Omit<ScopeDiffPack, 'diffPackHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    changedFiles: pack.changedFiles,
    hunks: pack.hunks.map(h => ({
      path: h.path,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: h.header,
      anchor: h.anchor,
      anchorKind: h.anchorKind,
      anchorRange: h.anchorRange,
      previousAnchor: h.previousAnchor,
      previousAnchorKind: h.previousAnchorKind,
      previousAnchorRange: h.previousAnchorRange,
      anchorParserVersion: h.anchorParserVersion,
      anchorArtifactVersion: h.anchorArtifactVersion,
      keyPath: h.keyPath,
      parseFallback: h.parseFallback,
      hunkDigest: h.hunkDigest,
      changeKind: h.changeKind,
    })),
  })).digest('hex');
}

function hashHunk(path: string, header: string, body: string[]): string {
  return createHash('sha256').update([path, header, ...body].join('\n')).digest('hex');
}

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] ? Number(match[4]) : 1,
  };
}

function inferChangeKind(body: string[]): ScopeDiffHunk['changeKind'] {
  const added = body.some(line => line.startsWith('+') && !line.startsWith('+++'));
  const removed = body.some(line => line.startsWith('-') && !line.startsWith('---'));
  if (added && removed) return 'modify';
  if (added) return 'add';
  if (removed) return 'remove';
  return 'modify';
}

interface AstAnchor {
  name: string;
  kind: string;
  range: { start: number; end: number };
}

function nodeName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const named = node as ts.NamedDeclaration;
  if (named.name) {
    if (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name)) return named.name.text;
    return named.name.getText(source).replace(/\s+/g, '');
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) return '<default>';
  if (ts.isModuleDeclaration(node)) return node.name.getText(source).replace(/^['"]|['"]$/g, '');
  return undefined;
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'module';
  if (ts.isVariableStatement(node) && node.parent && ts.isSourceFile(node.parent)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return 'exported-variable';
  return undefined;
}

function parserBackedAnchor(
  sourceText: string,
  path: string,
  lineNumber: number,
  lineCount: number,
): { anchor?: AstAnchor; parseFallback?: string } {
  const scriptKind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(path)
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return { parseFallback: 'typescript_parse_error_fail_closed' };
  const safeLine = Math.max(0, Math.min(lineNumber - 1, source.getLineStarts().length - 1));
  const start = source.getPositionOfLineAndCharacter(safeLine, 0);
  const endLine = Math.max(safeLine, Math.min(safeLine + Math.max(lineCount, 1) - 1, source.getLineStarts().length - 1));
  const end = endLine + 1 < source.getLineStarts().length
    ? source.getLineStarts()[endLine + 1] - 1
    : source.end;
  let best: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getFullStart() > start || node.end < end) return;
    if (node.getStart(source) <= end && node.end >= start && declarationKind(node) && nodeName(node, source)) best = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!best) {
    return {
      anchor: {
        name: `file:${path}`,
        kind: 'file',
        range: { start: 1, end: source.getLineStarts().length },
      },
      parseFallback: 'file_scope_no_enclosing_declaration',
    };
  }
  const startLine = source.getLineAndCharacterOfPosition(best.getStart(source)).line + 1;
  const endDeclLine = source.getLineAndCharacterOfPosition(best.end).line + 1;
  return {
    anchor: {
      name: nodeName(best, source)!,
      kind: declarationKind(best)!,
      range: { start: startLine, end: endDeclLine },
    },
  };
}

function inferPackageKeyPath(body: string[]): string | undefined {
  for (const raw of body) {
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;
    const line = raw.slice(1);
    const match = line.match(/"([^"]+)"\s*:/);
    if (match) return match[1];
  }
  return undefined;
}

function readBaseSource(projectRoot: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `main:${path}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

export function parseUnifiedDiff(projectRoot: string, diffText: string): ScopeDiffHunk[] {
  const hunks: ScopeDiffHunk[] = [];
  let currentPath = '';
  let currentHeader = '';
  let currentRange: ReturnType<typeof parseHunkHeader> = null;
  let currentBody: string[] = [];

  function flush(): void {
    if (!currentPath || !currentHeader || !currentRange) return;
    const sourcePath = join(projectRoot, currentPath);
    const isTsLike = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(currentPath);
    const isPackageJson = currentPath.endsWith('package.json') || currentPath.endsWith('.json');
    let anchor: string | undefined;
    let anchorKind: string | undefined;
    let anchorRange: { start: number; end: number } | undefined;
    let previousAnchor: string | undefined;
    let previousAnchorKind: string | undefined;
    let previousAnchorRange: { start: number; end: number } | undefined;
    let keyPath: string | undefined;
    let parseFallback: string | undefined;
    if (isTsLike) {
      const currentSourceExists = existsSync(sourcePath);
      if (currentSourceExists) {
        const parsed = parserBackedAnchor(
          readFileSync(sourcePath, 'utf8'),
          currentPath,
          currentRange.newStart,
          currentRange.newLines,
        );
        anchor = parsed.anchor?.name;
        anchorKind = parsed.anchor?.kind;
        anchorRange = parsed.anchor?.range;
        parseFallback = parsed.parseFallback;
      }
      const baseSource = readBaseSource(projectRoot, currentPath);
      if (baseSource !== undefined) {
        const previous = parserBackedAnchor(
          baseSource,
          currentPath,
          currentRange.oldStart,
          currentRange.oldLines,
        );
        previousAnchor = previous.anchor?.name;
        previousAnchorKind = previous.anchor?.kind;
        previousAnchorRange = previous.anchor?.range;
      }
      if (!currentSourceExists && !anchor && previousAnchor) parseFallback = 'deleted_source_uses_previous_declaration';
      if (!anchor && !previousAnchor && !parseFallback) parseFallback = 'typescript_source_unavailable_fail_closed';
    } else if (isPackageJson) {
      keyPath = inferPackageKeyPath(currentBody);
      if (!keyPath) parseFallback = 'no_json_key_detected';
    } else {
      parseFallback = 'unsupported_file_type';
    }
    hunks.push({
      path: currentPath,
      oldStart: currentRange.oldStart,
      oldLines: currentRange.oldLines,
      newStart: currentRange.newStart,
      newLines: currentRange.newLines,
      header: currentHeader,
      anchor,
      ...(anchorKind ? { anchorKind } : {}),
      ...(anchorRange ? { anchorRange } : {}),
      ...(previousAnchor ? { previousAnchor } : {}),
      ...(previousAnchorKind ? { previousAnchorKind } : {}),
      ...(previousAnchorRange ? { previousAnchorRange } : {}),
      ...(isTsLike ? {
        anchorParserVersion: SCOPE_ANCHOR_PARSER_VERSION,
        anchorArtifactVersion: SCOPE_ANCHOR_ARTIFACT_VERSION,
      } : {}),
      keyPath,
      parseFallback,
      changeKind: inferChangeKind(currentBody),
      hunkDigest: hashHunk(currentPath, currentHeader, currentBody),
    });
  }

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = '';
      currentHeader = '';
      currentRange = null;
      currentBody = [];
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('@@ ')) {
      flush();
      currentHeader = line;
      currentRange = parseHunkHeader(line);
      currentBody = [];
      continue;
    }
    if (currentHeader) currentBody.push(line);
  }
  flush();
  return hunks;
}

function readUnifiedDiff(gitCwd: string): string {
  const parts: string[] = [];
  for (const args of [
    ['diff', '--unified=20', 'main...HEAD'],
    ['diff', '--unified=20'],
    ['diff', '--unified=20', '--cached'],
  ]) {
    try {
      const output = execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (output) parts.push(output);
    } catch { /* ignore non-git contexts */ }
  }
  return parts.join('\n');
}

export function buildScopeDiffPack(projectRoot: string, now = new Date().toISOString()): ScopeDiffPack {
  const astMode = loadConfig(projectRoot).scopeProtection?.astAnchors ?? 'enforce';
  const packWithoutHash = {
    changedFiles: readChangedFiles(projectRoot),
    hunks: astMode === 'off'
      ? parseUnifiedDiff(projectRoot, readUnifiedDiff(projectRoot)).map((hunk) => ({
        ...hunk,
        anchor: undefined,
        anchorKind: undefined,
        anchorRange: undefined,
        previousAnchor: undefined,
        previousAnchorKind: undefined,
        previousAnchorRange: undefined,
        anchorParserVersion: undefined,
        anchorArtifactVersion: undefined,
        parseFallback: 'ast_anchor_rollout_off_legacy_history_preserved',
      }))
      : parseUnifiedDiff(projectRoot, readUnifiedDiff(projectRoot)),
    generatedAt: now,
    ...(astMode !== 'off' ? {
      anchorParserVersion: SCOPE_ANCHOR_PARSER_VERSION,
      anchorArtifactVersion: SCOPE_ANCHOR_ARTIFACT_VERSION,
    } : {}),
  };
  return {
    ...packWithoutHash,
    diffPackHash: digestScopeDiffPack(packWithoutHash),
  };
}
