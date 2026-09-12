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
import {
  classifyMaterialCodePath,
  materialPathExtension,
  resolveMaterialCodePolicy,
} from './material-code-policy.js';
import { GIT_TREE_OUTPUT_MAX_BUFFER } from './evidence-freshness.js';
import { resolveRepositoryBaseline } from './git-baseline.js';

export const SCOPE_ANCHOR_PARSER_VERSION = `typescript-${ts.versionMajorMinor}-ast-v1` as const;
export const SCOPE_ANCHOR_ARTIFACT_VERSION = 'proof-or-stop.scope-anchor.v1' as const;

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
      anchors: h.anchors,
      previousAnchors: h.previousAnchors,
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
  if (ts.isModuleDeclaration(node)) return node.name.getText(source).replace(/^['"]|['"]$/g, '');
  const named = node as ts.NamedDeclaration;
  if (named.name) {
    if (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name)) return named.name.text;
    return named.name.getText(source).replace(/\s+/g, '');
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) return '<default>';
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
  if (
    ts.isVariableDeclaration(node)
    && ts.isVariableDeclarationList(node.parent)
    && ts.isVariableStatement(node.parent.parent)
    && ts.isSourceFile(node.parent.parent.parent)
  ) return 'top-level-variable';
  return undefined;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function parserBackedAnchors(
  sourceText: string,
  path: string,
  lineNumber: number,
  lineCount: number,
): { anchors: AstAnchor[]; parseFallback?: string } {
  const scriptKind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(path)
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return { anchors: [], parseFallback: 'typescript_parse_error_fail_closed' };
  const lineStarts = source.getLineStarts();
  const firstLine = Math.max(0, Math.min(lineNumber - 1, lineStarts.length - 1));
  const lastLine = Math.max(firstLine, Math.min(firstLine + Math.max(lineCount, 1) - 1, lineStarts.length - 1));
  const anchors: AstAnchor[] = [];
  for (let line = firstLine; line <= lastLine; line++) {
    const start = lineStarts[line];
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : source.end;
    const candidates: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (node.getFullStart() > end || node.end < start) return;
      if (node.getStart(source) <= end && node.end >= start && declarationKind(node) && nodeName(node, source)) {
        candidates.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const nearest = candidates.filter((candidate) => (
      !candidates.some((other) => other !== candidate && isDescendantOf(other, candidate))
    ));
    for (const node of nearest) {
      const anchor: AstAnchor = {
        name: nodeName(node, source)!,
        kind: declarationKind(node)!,
        range: {
          start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          end: source.getLineAndCharacterOfPosition(node.end).line + 1,
        },
      };
      if (!anchors.some((candidate) => (
        candidate.name === anchor.name
        && candidate.kind === anchor.kind
        && candidate.range.start === anchor.range.start
        && candidate.range.end === anchor.range.end
      ))) anchors.push(anchor);
    }
  }
  if (anchors.length > 0) return { anchors };
  return {
    anchors: [{
      name: `file:${path}`,
      kind: 'file',
      range: { start: 1, end: lineStarts.length },
    }],
    parseFallback: 'file_scope_no_enclosing_declaration',
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

/** One historical snapshot per parse; current working-tree reads remain fresh. */
function createBaseSourceReader(gitCwd: string): { read(path: string): string | undefined; pinFailed(): boolean } {
  let pinFailure = false;
  let initialized = false;
  let baselineCommit: string | undefined;
  const sources = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    if (!initialized) {
      initialized = true;
      try {
        const baseline = resolveRepositoryBaseline(gitCwd);
        if (baseline) {
          // Existing anchors read the selected integration tip, not mergeBase.
          // Pin its object identity so one parse cannot mix moving ref versions.
          try {
            baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baseline.ref}^{commit}`], {
              cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            pinFailure = !baselineCommit;
          } catch { pinFailure = true; } // Never fall back to a moving live ref.
        }
      } catch { /* unavailable history preserves the existing fail-closed fallback */ }
    }
    if (!baselineCommit) return undefined;
    if (!sources.has(path)) {
      let source: string | undefined;
      try {
        source = execFileSync('git', ['show', `${baselineCommit}:${path}`], {
          cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* cache missing source only for this invocation */ }
      sources.set(path, source);
    }
    return sources.get(path);
  };
  return { read, pinFailed: () => pinFailure };
}

interface ChangedBlock {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string[];
}

function changedBlocks(
  range: NonNullable<ReturnType<typeof parseHunkHeader>>,
  body: string[],
): ChangedBlock[] {
  const blocks: ChangedBlock[] = [];
  let oldLine = range.oldStart;
  let newLine = range.newStart;
  let active: { old: number[]; next: number[]; body: string[] } | null = null;
  const flush = (): void => {
    if (!active) return;
    blocks.push({
      oldStart: active.old[0] ?? oldLine,
      oldLines: active.old.length,
      newStart: active.next[0] ?? newLine,
      newLines: active.next.length,
      body: active.body,
    });
    active = null;
  };
  for (const line of body) {
    if (line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      active ??= { old: [], next: [], body: [] };
      active.next.push(newLine++);
      active.body.push(line);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      active ??= { old: [], next: [], body: [] };
      active.old.push(oldLine++);
      active.body.push(line);
      continue;
    }
    flush();
    oldLine++;
    newLine++;
  }
  flush();
  return blocks.length > 0 ? blocks : [{
    oldStart: range.oldStart,
    oldLines: 0,
    newStart: range.newStart,
    newLines: 0,
    body: [],
  }];
}

export function parseUnifiedDiff(projectRoot: string, diffText: string): ScopeDiffHunk[] {
  const hunks: ScopeDiffHunk[] = [];
  const baseSourceReader = createBaseSourceReader(projectRoot);
  let currentPath = '';
  let oldPath = '';
  let identityKind: 'rename' | 'copy' | undefined;
  let currentHeader = '';
  let currentRange: ReturnType<typeof parseHunkHeader> = null;
  let currentBody: string[] = [];
  let fileHunkCount = 0;

  function flush(): void {
    if (!currentPath || !currentHeader || !currentRange) return;
    const blocks = changedBlocks(currentRange, currentBody);
    const sourcePath = join(projectRoot, currentPath);
    const previousPath = oldPath || currentPath;
    const isRename = identityKind === 'rename' && previousPath !== currentPath;
    const isCopy = identityKind === 'copy';
    const isTsLike = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(currentPath);
    const isPackageJson = currentPath.endsWith('package.json') || currentPath.endsWith('.json');
    const currentSource = isTsLike && existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : undefined;
    const baseSource = isTsLike ? baseSourceReader.read(previousPath) : undefined;
    for (const [blockIndex, block] of blocks.entries()) {
      let anchors: AstAnchor[] = [];
      let previousAnchors: AstAnchor[] = [];
      let keyPath: string | undefined;
      let parseFallback: string | undefined;
      if (isTsLike) {
        if (currentSource !== undefined && block.newLines > 0) {
          const parsed = parserBackedAnchors(currentSource, currentPath, block.newStart, block.newLines);
          anchors = parsed.anchors;
          parseFallback = parsed.parseFallback;
        }
        if (baseSource !== undefined && block.oldLines > 0) {
          const previous = parserBackedAnchors(baseSource, previousPath, block.oldStart, block.oldLines);
          previousAnchors = previous.anchors;
          parseFallback ??= previous.parseFallback;
        }
        if (isCopy) {
          parseFallback = 'typescript_copy_identity_unsupported_fail_closed';
        } else if (isRename && currentSource === undefined) {
          parseFallback = 'typescript_rename_target_source_unavailable_fail_closed';
        } else if (isRename && baseSource === undefined) {
          parseFallback = 'typescript_rename_previous_source_unavailable_fail_closed';
        } else if (currentSource === undefined && previousAnchors.length > 0) {
          parseFallback = 'deleted_source_uses_previous_declaration';
        }
        if (anchors.length === 0 && previousAnchors.length === 0 && !parseFallback) parseFallback = 'typescript_source_unavailable_fail_closed';
      } else if (isPackageJson) {
        keyPath = inferPackageKeyPath(block.body);
        if (!keyPath) parseFallback = 'no_json_key_detected';
      } else {
        parseFallback = 'unsupported_file_type';
      }
      if (isTsLike && baseSourceReader.pinFailed()) parseFallback = 'typescript_baseline_pin_unresolved_fail_closed';
      const anchor = anchors[0];
      const previousAnchor = previousAnchors[0];
      hunks.push({
        path: currentPath,
        oldStart: block.oldStart,
        oldLines: block.oldLines,
        newStart: block.newStart,
        newLines: block.newLines,
        header: `${currentHeader} [changed-span:${blockIndex + 1}/${blocks.length}]`,
        ...(anchor ? { anchor: anchor.name, anchorKind: anchor.kind, anchorRange: anchor.range } : {}),
        ...(previousAnchor ? {
          previousAnchor: previousAnchor.name,
          previousAnchorKind: previousAnchor.kind,
          previousAnchorRange: previousAnchor.range,
        } : {}),
        ...(anchors.length > 0 ? { anchors } : {}),
        ...(previousAnchors.length > 0 ? { previousAnchors } : {}),
        ...(isTsLike ? {
          anchorParserVersion: SCOPE_ANCHOR_PARSER_VERSION,
          anchorArtifactVersion: SCOPE_ANCHOR_ARTIFACT_VERSION,
        } : {}),
        keyPath,
        parseFallback,
        changeKind: inferChangeKind(block.body),
        hunkDigest: hashHunk(currentPath, `${currentHeader}:${blockIndex}`, block.body),
      });
    }
    fileHunkCount += 1;
  }

  function appendIdentityOnlyHunk(): void {
    if (!identityKind || fileHunkCount > 0 || !oldPath || !currentPath) return;
    const isTsLike = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(currentPath);
    const currentSource = isTsLike && existsSync(join(projectRoot, currentPath))
      ? readFileSync(join(projectRoot, currentPath), 'utf8')
      : undefined;
    const baseSource = isTsLike ? baseSourceReader.read(oldPath) : undefined;
    let anchors: AstAnchor[] = [];
    let previousAnchors: AstAnchor[] = [];
    let parseFallback: string | undefined;
    if (isTsLike) {
      if (currentSource !== undefined) {
        const parsed = parserBackedAnchors(
          currentSource,
          currentPath,
          1,
          Math.max(currentSource.split(/\r?\n/).length, 1),
        );
        anchors = parsed.anchors;
        parseFallback = parsed.parseFallback;
      }
      if (baseSource !== undefined) {
        const previous = parserBackedAnchors(
          baseSource,
          oldPath,
          1,
          Math.max(baseSource.split(/\r?\n/).length, 1),
        );
        previousAnchors = previous.anchors;
        parseFallback ??= previous.parseFallback;
      }
      if (identityKind === 'copy') {
        parseFallback = 'typescript_copy_identity_unsupported_fail_closed';
      } else if (currentSource === undefined) {
        parseFallback = 'typescript_rename_target_source_unavailable_fail_closed';
      } else if (baseSource === undefined) {
        parseFallback = 'typescript_rename_previous_source_unavailable_fail_closed';
      }
    } else {
      parseFallback = identityKind === 'copy'
        ? 'copy_identity_unsupported_fail_closed'
        : 'unsupported_file_type';
    }
    if (isTsLike && baseSourceReader.pinFailed()) parseFallback = 'typescript_baseline_pin_unresolved_fail_closed';
    const anchor = anchors[0];
    const previousAnchor = previousAnchors[0];
    const header = `@@ identity:${identityKind} ${oldPath} -> ${currentPath} @@`;
    hunks.push({
      path: currentPath,
      oldStart: 1,
      oldLines: baseSource?.split(/\r?\n/).length ?? 0,
      newStart: 1,
      newLines: currentSource?.split(/\r?\n/).length ?? 0,
      header,
      ...(anchor ? { anchor: anchor.name, anchorKind: anchor.kind, anchorRange: anchor.range } : {}),
      ...(previousAnchor ? {
        previousAnchor: previousAnchor.name,
        previousAnchorKind: previousAnchor.kind,
        previousAnchorRange: previousAnchor.range,
      } : {}),
      ...(anchors.length > 0 ? { anchors } : {}),
      ...(previousAnchors.length > 0 ? { previousAnchors } : {}),
      ...(isTsLike ? {
        anchorParserVersion: SCOPE_ANCHOR_PARSER_VERSION,
        anchorArtifactVersion: SCOPE_ANCHOR_ARTIFACT_VERSION,
      } : {}),
      parseFallback,
      changeKind: 'modify',
      hunkDigest: hashHunk(currentPath, header, [`${identityKind}:${oldPath}->${currentPath}`]),
    });
    fileHunkCount += 1;
  }

  function finishFile(): void {
    flush();
    appendIdentityOnlyHunk();
  }

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      currentPath = '';
      oldPath = '';
      identityKind = undefined;
      currentHeader = '';
      currentRange = null;
      currentBody = [];
      fileHunkCount = 0;
      continue;
    }
    if (line.startsWith('rename from ')) {
      identityKind = 'rename';
      oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      identityKind = 'rename';
      currentPath = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('copy from ')) {
      identityKind = 'copy';
      oldPath = line.slice('copy from '.length);
      continue;
    }
    if (line.startsWith('copy to ')) {
      identityKind = 'copy';
      currentPath = line.slice('copy to '.length);
      continue;
    }
    if (line.startsWith('--- a/')) {
      oldPath = line.slice('--- a/'.length);
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    if (line === '+++ /dev/null') {
      currentPath = oldPath;
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
  finishFile();
  return hunks;
}

function readUnifiedDiff(gitCwd: string): string {
  const parts: string[] = [];
  const baseline = resolveRepositoryBaseline(gitCwd);
  for (const args of [
    ...(baseline ? [['diff', '--find-renames', '--find-copies', '--unified=20', `${baseline.ref}...HEAD`]] : []),
    ['diff', '--find-renames', '--find-copies', '--unified=20'],
    ['diff', '--find-renames', '--find-copies', '--unified=20', '--cached'],
  ]) {
    try {
      const output = execFileSync('git', args, {
        cwd: gitCwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
      }).trim();
      if (output) parts.push(output);
    } catch { /* ignore non-git contexts */ }
  }
  return parts.join('\n');
}

/**
 * B-956f: normalized, deduped extensions (no leading dot, sorted) of MATERIAL
 * code files in the diff that receive no TS/JS semantic anchor analysis. TS/JS
 * hunks never carry the `unsupported_file_type` fallback, so they produce none.
 * Docs/binary changes are excluded via the material-code policy. Pure: derived
 * from the hunks + policy, writes no events. Fails soft — a malformed policy
 * config (surfaced fail-closed by the floor/repro gates) yields no diagnostics
 * here rather than throwing inside every read-only diff-pack build.
 */
export function collectSemanticAnalysisUnavailable(
  metadataRoot: string,
  hunks: readonly ScopeDiffHunk[],
): string[] {
  let policy;
  try {
    policy = resolveMaterialCodePolicy(metadataRoot);
  } catch {
    return [];
  }
  const extensions = new Set<string>();
  for (const hunk of hunks) {
    if (hunk.parseFallback !== 'unsupported_file_type') continue;
    if (!classifyMaterialCodePath(policy, hunk.path, { projectRoot: metadataRoot }).materialCode) continue;
    const ext = materialPathExtension(hunk.path).replace(/^\./, '') || '<no-extension>';
    extensions.add(ext);
  }
  return [...extensions].sort();
}

export interface SemanticDegradationEvent {
  type: 'semantic_analysis_unavailable';
  extensions: string[];
}

/**
 * Pure builder for the union-typed degradation process event. Returns null when
 * there is nothing to report so a mutating caller emits at most one deduped
 * event and read-only callers can skip emission entirely.
 */
export function buildSemanticDegradationEvent(
  pack: Pick<ScopeDiffPack, 'semanticAnalysisUnavailable'>,
): SemanticDegradationEvent | null {
  const extensions = [...new Set(pack.semanticAnalysisUnavailable ?? [])].sort();
  return extensions.length > 0 ? { type: 'semantic_analysis_unavailable', extensions } : null;
}

export function buildScopeDiffPack(
  metadataRoot: string,
  now = new Date().toISOString(),
  gitCwd = metadataRoot,
): ScopeDiffPack {
  const astMode = loadConfig(metadataRoot).scopeProtection?.astAnchors ?? 'enforce';
  const packWithoutHash = {
    changedFiles: readChangedFiles(gitCwd),
    hunks: astMode === 'off'
      ? parseUnifiedDiff(gitCwd, readUnifiedDiff(gitCwd)).map((hunk) => ({
        ...hunk,
        anchor: undefined,
        anchors: undefined,
        anchorKind: undefined,
        anchorRange: undefined,
        previousAnchor: undefined,
        previousAnchors: undefined,
        previousAnchorKind: undefined,
        previousAnchorRange: undefined,
        anchorParserVersion: undefined,
        anchorArtifactVersion: undefined,
        parseFallback: 'ast_anchor_rollout_off_legacy_history_preserved',
      }))
      : parseUnifiedDiff(gitCwd, readUnifiedDiff(gitCwd)),
    generatedAt: now,
    ...(astMode !== 'off' ? {
      anchorParserVersion: SCOPE_ANCHOR_PARSER_VERSION,
      anchorArtifactVersion: SCOPE_ANCHOR_ARTIFACT_VERSION,
    } : {}),
    astAnchorMode: astMode,
  };
  // Derived degradation diagnostic — computed AFTER the digest so it never
  // perturbs diffPackHash (backward-compatible with signed scope artifacts).
  const semanticAnalysisUnavailable = collectSemanticAnalysisUnavailable(metadataRoot, packWithoutHash.hunks);
  return {
    ...packWithoutHash,
    diffPackHash: digestScopeDiffPack(packWithoutHash),
    ...(semanticAnalysisUnavailable.length > 0 ? { semanticAnalysisUnavailable } : {}),
  };
}
