/**
 * validate-concept — CLI gate: deleted-symbol residual check
 *
 * Extract deleted declarations (TS / Python) from `git diff main...HEAD`, then for each symbol
 * grep the entire repo, listing residual references that have not yet been cleaned up. Threshold 5:
 *
 * - residuals.length == 0     → status=pass, recommendation="skip concept LLM reviewer"
 * - 1 ≤ residuals.length < 5  → status=warn, recommendation="skip concept LLM reviewer"
 * - residuals.length ≥ 5      → status=warn, recommendation="dispatch proof-or-stop-review-concept"
 *
 * Output structure:
 *   {
 *     provider: "proof-or-stop-concept",
 *     status: "pass" | "warn",
 *     summary: string,
 *     deletedSymbols: string[],
 *     residuals: Array<{ symbol, file, line, snippet }>,
 *     recommendation: "skip concept LLM reviewer" | "dispatch proof-or-stop-review-concept"
 *   }
 *
 * See docs/reviewer-redesign.md §III S1 item 2.
 */

import { execSync } from 'node:child_process';
import ts from 'typescript';
import { DEFAULT_BASE } from './validate-shared.js';
import { STATE_DIR_NAMES } from '../core/brand-paths.js';
import {
  classifyMaterialCodePath,
  materialPathExtension,
  resolveMaterialCodePolicy,
} from '../core/material-code-policy.js';

export interface ConceptResidual {
  symbol: string;
  file: string;
  line: number;
  snippet: string;
}

export interface ConceptCheckResult {
  // F-017 (B-9d95 Round 1 review): residuals ≥ 5 upgraded to fail (instead of warn),
  // aligned with the ok=false semantics returned by runConceptGateCli/CLI gate, rendering shows ✗ fail.
  provider: 'proof-or-stop-concept';
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  deletedSymbols: string[];
  residuals: ConceptResidual[];
  diagnostics?: string[];
  /**
   * B-956f (spec Change D): concept-analysis's own DISTINCT skip diagnostic —
   * names material-code non-TS/py source files concept analysis does not parse.
   * Independent of `diagnostics` (fail-closed parse errors) and of scope-diff
   * pack semantic_analysis_unavailable events; never fails the gate.
   */
  skipDiagnostics?: string[];
  recommendation: 'skip concept LLM reviewer' | 'dispatch proof-or-stop-review-concept';
}

/** Readers can be injected for tests. Default uses `git diff main...HEAD`. */
export type GitDiffReader = (args: { base: string; projectRoot: string }) => string;

export type GrepReader = (args: {
  symbol: string;
  projectRoot: string;
}) => string;

/**
 * Directories we never want to scan (would create false positives / self-reference).
 *
 * B-cc10 CHK-002: state-dir spellings come from the resolver. A hardcoded spelling
 * would silently stop excluding the state directory after the rename, flooding the
 * concept gate with residual "hits" from archived story metadata.
 */
export const IGNORED_DIRS = [
  'node_modules',
  'dist',
  '.git',
  ...STATE_DIR_NAMES,
  'tmp',
  '.worktrees',
];

const IGNORED_PATH_PREFIXES = [
  ...STATE_DIR_NAMES.map(dir => `${dir}/`),
  'docs/story/',
  'tests/fixtures/',
  'packages/main/tests/fixtures/',
];

function isIgnoredResidualFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return IGNORED_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

// B-6666: the reader's `projectRoot` field actually carries the RESOLVED gitCwd
// (checkConcept threads deps.gitCwd in as `projectRoot: gitCwd` — B-2856). Alias
// it to `gitCwd` locally so the git child-process `cwd:` is lexically honest (and
// passes the strengthened gitroot-cwd-contract bare-cwd rule). The public
// GitDiffReader/GrepReader field name stays `projectRoot` (no external ripple).
const defaultGitDiffReader: GitDiffReader = ({ base, projectRoot: gitCwd }) => {
  // Declaration identity includes lexical scope. Full context ensures a method
  // hunk still contains its enclosing class/function when reconstructed below.
  return execSync(`git diff --unified=1000000 ${base}...HEAD`, {
    cwd: gitCwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
};

const defaultGrepReader: GrepReader = ({ symbol, projectRoot: gitCwd }) => {
  // -rn → recursive + line numbers, -F → fixed string (symbol may contain `_`)
  // --exclude-dir handles each ignored subdir. swallow non-zero (exit 1 = no match).
  const excludes = IGNORED_DIRS.map((d) => `--exclude-dir=${d}`).join(' ');
  try {
    return execSync(`grep -rnF ${excludes} -- ${JSON.stringify(symbol)} .`, {
      cwd: gitCwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e: any) {
    // grep exit 1 = no match (not an error for us)
    if (e?.status === 1) return '';
    throw e;
  }
};

// ── symbol extraction from diff ──

/**
 * Extract deleted declarations (TS / Python) from the raw `git diff` text.
 *
 * Rule: collect declarations from removed and added diff lines, then report only
 * removed declaration identities that have no matching added declaration. This
 * prevents a changed declaration line from looking like a deletion while still
 * treating renames, export removal, and true declaration removal as deletions.
 *
 * TypeScript is parsed with the compiler API; Python uses indentation-aware
 * declaration parsing. Identity includes file, lexical scope, declaration kind,
 * name, export state where applicable, and normalized signature.
 *
 * Returns a deduplicated and sorted symbol list.
 */
interface DiffFileSources {
  oldPath: string;
  newPath: string;
  oldSource: string;
  newSource: string;
  copy: boolean;
}

interface DeclarationIdentity {
  key: string;
  continuityKey: string;
  name: string;
}

interface DeletedSymbolAnalysis {
  symbols: string[];
  diagnostics: string[];
  /**
   * B-956f (spec Change D): concept-analysis's OWN, DISTINCT skip channel —
   * material-code files in a language concept analysis does not parse (non-TS/py,
   * e.g. .go/.rs). Kept strictly separate from `diagnostics` (which are
   * fail-closed parse errors) so a language skip never fails the gate, and never
   * conflated with scope-diff-pack's semantic_analysis_unavailable events.
   */
  skipDiagnostics: string[];
}

const DIFF_SOURCE_DIAGNOSTICS = new WeakMap<DiffFileSources[], string[]>();

interface ParsedGitPath {
  value: string;
  end: number;
}

interface DiffPathCandidate {
  oldPath: string;
  newPath: string;
}

function parseQuotedGitPath(input: string, start = 0): ParsedGitPath {
  if (input[start] !== '"') throw new Error('expected opening quote');
  const bytes: number[] = [];
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      let value: string;
      try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      } catch {
        throw new Error('quoted path contains invalid UTF-8 bytes');
      }
      return { value, end: index + 1 };
    }
    if (character !== '\\') {
      const codePoint = input.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    const escaped = input[index + 1];
    if (escaped === undefined) throw new Error('quoted path ends with an escape');
    if (/[0-7]/.test(escaped)) {
      const octal = input.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? '';
      const value = Number.parseInt(octal, 8);
      if (value > 0xff) throw new Error(`quoted path octal escape is outside one byte: \\${octal}`);
      bytes.push(value);
      index += octal.length;
      continue;
    }
    const standardEscapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    };
    const decoded = standardEscapes[escaped];
    if (decoded === undefined) throw new Error(`quoted path contains unsupported escape \\${escaped}`);
    bytes.push(decoded);
    index += 1;
  }
  throw new Error('quoted path is missing its closing quote');
}

function parseSingleGitPath(input: string): string {
  if (!input.startsWith('"')) return input;
  const parsed = parseQuotedGitPath(input);
  if (input.slice(parsed.end).trim() !== '') throw new Error('quoted path has trailing content');
  return parsed.value;
}

function stripGitSidePrefix(path: string, prefix: 'a/' | 'b/'): string {
  if (path === '/dev/null') return path;
  if (!path.startsWith(prefix)) throw new Error(`path must start with ${prefix}`);
  return path.slice(prefix.length);
}

function parseDiffGitPaths(input: string): DiffPathCandidate[] {
  if (input.startsWith('"')) {
    const oldToken = parseQuotedGitPath(input);
    let cursor = oldToken.end;
    if (input[cursor] !== ' ') throw new Error('quoted diff path pair is missing a separator');
    while (input[cursor] === ' ') cursor += 1;
    const newToken = input[cursor] === '"'
      ? parseQuotedGitPath(input, cursor)
      : { value: input.slice(cursor), end: input.length };
    if (input.slice(newToken.end).trim() !== '') throw new Error('diff path pair has trailing content');
    return [{
      oldPath: stripGitSidePrefix(oldToken.value, 'a/'),
      newPath: stripGitSidePrefix(newToken.value, 'b/'),
    }];
  }
  if (!input.startsWith('a/')) throw new Error('diff path pair is malformed');
  const candidates: DiffPathCandidate[] = [];
  let cursor = 0;
  while (true) {
    const separator = input.indexOf(' b/', cursor);
    if (separator < 0) break;
    candidates.push({
      oldPath: input.slice(2, separator),
      newPath: input.slice(separator + 3),
    });
    cursor = separator + 1;
  }
  if (candidates.length === 0) throw new Error('diff path pair has no syntactically possible b/ delimiter');
  return candidates;
}

function diffFileSources(diff: string): DiffFileSources[] {
  const files: DiffFileSources[] = [];
  const diagnostics: string[] = [];
  const structuredDiffToken = /^(?:diff --git(?=$|\s)|---(?=$|\s)|\+\+\+(?=$|\s)|@@|(?:rename|copy) (?:from|to)(?=$|\s)|Binary files(?=$|\s)|GIT binary patch(?=$|\s)|(?:index|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index)(?=$|\s))/;
  const hasStructuredDiffToken = diff.split('\n').some(line => structuredDiffToken.test(line));
  if (!hasStructuredDiffToken) {
    if (diff.trim() === '') {
      DIFF_SOURCE_DIAGNOSTICS.set(files, diagnostics);
      return files;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of diff.split('\n')) {
      if (line.startsWith('-')) oldLines.push(line.slice(1));
      else if (line.startsWith('+')) newLines.push(line.slice(1));
      else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
    }
    files.push({
      oldPath: '__fragment__.ts',
      newPath: '__fragment__.ts',
      oldSource: oldLines.join('\n'),
      newSource: newLines.join('\n'),
      copy: false,
    });
    DIFF_SOURCE_DIAGNOSTICS.set(files, diagnostics);
    return files;
  }
  let current: {
    oldPath: string;
    newPath: string;
    headerCandidates: DiffPathCandidate[];
    oldSourcePath: string;
    newSourcePath: string;
    oldLines: string[];
    newLines: string[];
    oldSideHeaders: string[];
    newSideHeaders: string[];
    renameFrom: string[];
    renameTo: string[];
    copyFrom: string[];
    copyTo: string[];
    metadataMalformed: boolean;
    phase: 'metadata' | 'old-side' | 'side-pair' | 'hunk' | 'binary';
    hunkCount: number;
    removedContentCount: number;
    addedContentCount: number;
    sawPatchContent: boolean;
  } | null = null;
  let invalidSection = false;
  const flush = () => {
    if (!current) return;
    const metadataDiagnostics: string[] = [];
    const oldSide = current.oldSideHeaders.at(-1);
    const newSide = current.newSideHeaders.at(-1);
    const metadataOld = [...current.renameFrom, ...current.copyFrom];
    const metadataNew = [...current.renameTo, ...current.copyTo];
    if (
      (oldSide === '/dev/null' || newSide === '/dev/null')
      && !current.headerCandidates.some(candidate => candidate.oldPath === candidate.newPath)
    ) {
      metadataDiagnostics.push('/dev/null patch header identities must describe the same path');
    }
    const hasCorroboration = oldSide !== undefined
      || newSide !== undefined
      || metadataOld.length > 0
      || metadataNew.length > 0;
    let authorityCandidates = current.headerCandidates.filter(candidate => {
      if (oldSide !== undefined && oldSide !== '/dev/null' && candidate.oldPath !== oldSide) return false;
      if (newSide !== undefined && newSide !== '/dev/null' && candidate.newPath !== newSide) return false;
      if (metadataOld.some(path => path !== candidate.oldPath)) return false;
      if (metadataNew.some(path => path !== candidate.newPath)) return false;
      if (
        (oldSide === '/dev/null' || newSide === '/dev/null')
        && candidate.oldPath !== candidate.newPath
      ) return false;
      return true;
    });
    if (!hasCorroboration && current.headerCandidates.length > 1) {
      authorityCandidates = authorityCandidates.filter(candidate => candidate.oldPath === candidate.newPath);
    }
    if (authorityCandidates.length === 1) {
      current.oldPath = authorityCandidates[0]!.oldPath;
      current.newPath = authorityCandidates[0]!.newPath;
      if (current.oldSideHeaders.length === 0) current.oldSourcePath = current.oldPath;
      if (current.newSideHeaders.length === 0) current.newSourcePath = current.newPath;
    } else {
      metadataDiagnostics.push(
        `unquoted diff header path is ${authorityCandidates.length === 0 ? 'unresolved' : 'ambiguous'} after corroboration (${authorityCandidates.length} candidate(s))`,
      );
      current.metadataMalformed = true;
    }
    const hasRename = current.renameFrom.length > 0 || current.renameTo.length > 0;
    const hasCopy = current.copyFrom.length > 0 || current.copyTo.length > 0;
    if (hasRename && hasCopy) {
      metadataDiagnostics.push('rename and copy metadata are mutually exclusive');
    }
    const validateMetadataPair = (
      kind: 'rename' | 'copy',
      from: string[],
      to: string[],
    ) => {
      if (from.length !== 1 || to.length !== 1) {
        metadataDiagnostics.push(
          `${kind} metadata must contain exactly one from/to pair (from=${from.length}, to=${to.length})`,
        );
        return;
      }
      if (from[0] !== current!.oldPath || to[0] !== current!.newPath) {
        metadataDiagnostics.push(
          `${kind} metadata paths do not match diff header (${from[0]} -> ${to[0]} vs ${current!.oldPath} -> ${current!.newPath})`,
        );
      }
    };
    if (hasRename) validateMetadataPair('rename', current.renameFrom, current.renameTo);
    if (hasCopy) validateMetadataPair('copy', current.copyFrom, current.copyTo);
    if (oldSide !== undefined && oldSide !== '/dev/null' && oldSide !== current.oldPath) {
      metadataDiagnostics.push(`--- path ${oldSide} does not match authoritative old path ${current.oldPath}`);
    }
    if (newSide !== undefined && newSide !== '/dev/null' && newSide !== current.newPath) {
      metadataDiagnostics.push(`+++ path ${newSide} does not match authoritative new path ${current.newPath}`);
    }
    if (current.oldSideHeaders.length !== current.newSideHeaders.length) {
      metadataDiagnostics.push('patch side headers must contain a complete ---/+++ pair');
    }
    if (current.oldSideHeaders.length > 1 || current.newSideHeaders.length > 1) {
      metadataDiagnostics.push(
        `patch side headers may appear at most once (old=${current.oldSideHeaders.length}, new=${current.newSideHeaders.length})`,
      );
    }
    if (
      current.oldSourcePath === '/dev/null'
      && current.newSourcePath === '/dev/null'
    ) {
      metadataDiagnostics.push('both patch sides cannot be /dev/null');
    }
    if (
      (hasRename || hasCopy)
      && (current.oldSourcePath === '/dev/null' || current.newSourcePath === '/dev/null')
    ) {
      metadataDiagnostics.push('rename/copy metadata cannot be combined with /dev/null patch sides');
    }
    if (
      current.oldSideHeaders.length === 1
      && current.newSideHeaders.length === 1
      && current.hunkCount === 0
      && current.phase !== 'binary'
    ) {
      metadataDiagnostics.push('patch side headers must be followed by at least one @@ hunk');
    }
    if (
      (current.oldSourcePath === '/dev/null' || current.newSourcePath === '/dev/null')
      && current.oldPath !== current.newPath
    ) {
      metadataDiagnostics.push(
        `/dev/null patch header identities must describe the same path (${current.oldPath} vs ${current.newPath})`,
      );
    }
    if (current.oldSourcePath === '/dev/null' && current.removedContentCount > 0) {
      metadataDiagnostics.push('addition patch cannot contain removed content');
    }
    if (current.newSourcePath === '/dev/null' && current.addedContentCount > 0) {
      metadataDiagnostics.push('deletion patch cannot contain added content');
    }
    if (current.phase === 'binary') {
      const binaryEndpoints = new Set([
        current.oldPath,
        current.newPath,
        current.oldSourcePath,
        current.newSourcePath,
        ...current.renameFrom,
        ...current.renameTo,
        ...current.copyFrom,
        ...current.copyTo,
      ]);
      const supportedBinaryPaths = [...binaryEndpoints]
        .filter(path => path !== '/dev/null' && isSupportedDeclarationPath(path));
      if (supportedBinaryPaths.length > 0) {
        metadataDiagnostics.push(
          `binary diff touches supported declaration-bearing source path(s): ${supportedBinaryPaths.join(', ')}`,
        );
      }
    }
    diagnostics.push(...metadataDiagnostics.map(message => `diff metadata: ${message}`));
    const validCopy = hasCopy
      && !hasRename
      && !current.metadataMalformed
      && metadataDiagnostics.length === 0;
    files.push({
      oldPath: current.oldSourcePath,
      newPath: current.newSourcePath,
      oldSource: current.oldLines.join('\n'),
      newSource: current.newLines.join('\n'),
      copy: validCopy,
    });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      try {
        const headerCandidates = parseDiffGitPaths(line.slice('diff --git '.length));
        current = {
          oldPath: '',
          newPath: '',
          headerCandidates,
          oldSourcePath: '/dev/null',
          newSourcePath: '/dev/null',
          oldLines: [],
          newLines: [],
          oldSideHeaders: [],
          newSideHeaders: [],
          renameFrom: [],
          renameTo: [],
          copyFrom: [],
          copyTo: [],
          metadataMalformed: false,
          phase: 'metadata',
          hunkCount: 0,
          removedContentCount: 0,
          addedContentCount: 0,
          sawPatchContent: false,
        };
        invalidSection = false;
      } catch (error) {
        diagnostics.push(`diff path: ${error instanceof Error ? error.message : String(error)}`);
        current = null;
        invalidSection = true;
      }
      continue;
    }
    if (!current) {
      if (invalidSection) continue;
      if (line.trim() !== '') {
        diagnostics.push('diff section: content appeared before an authoritative diff --git header');
        invalidSection = true;
      }
      continue;
    }
    try {
      if (line.startsWith('@@')) {
        if (current.phase !== 'side-pair' && current.phase !== 'hunk') {
          diagnostics.push('diff ordering: @@ hunk must follow a complete ---/+++ side-header pair');
          current.metadataMalformed = true;
          continue;
        }
        current.phase = 'hunk';
        current.hunkCount += 1;
        // Separate later hunks without shifting a first-line shebang to line 2.
        if (current.oldLines.length > 0 || current.newLines.length > 0) {
          current.oldLines.push('');
          current.newLines.push('');
        }
      } else if (line.startsWith('--- ')) {
        if (current.phase !== 'metadata' || current.sawPatchContent || current.oldSideHeaders.length > 0) {
          diagnostics.push('diff ordering: --- side header is reversed, duplicated, or appears after patch content');
          current.metadataMalformed = true;
          continue;
        }
        const path = stripGitSidePrefix(parseSingleGitPath(line.slice(4)), 'a/');
        current.oldSideHeaders.push(path);
        current.oldSourcePath = path;
        current.phase = 'old-side';
      } else if (line.startsWith('+++ ')) {
        if (current.phase !== 'old-side' || current.sawPatchContent || current.newSideHeaders.length > 0) {
          diagnostics.push('diff ordering: +++ side header must follow exactly one --- side header');
          current.metadataMalformed = true;
          continue;
        }
        const path = stripGitSidePrefix(parseSingleGitPath(line.slice(4)), 'b/');
        current.newSideHeaders.push(path);
        current.newSourcePath = path;
        current.phase = 'side-pair';
      } else if (line.startsWith('rename from ')) {
        if (current.phase !== 'metadata' || current.sawPatchContent) {
          diagnostics.push('diff ordering: rename metadata must appear before side headers and hunks');
          current.metadataMalformed = true;
          continue;
        }
        current.renameFrom.push(parseSingleGitPath(line.slice('rename from '.length)));
      } else if (line.startsWith('rename to ')) {
        if (current.phase !== 'metadata' || current.sawPatchContent) {
          diagnostics.push('diff ordering: rename metadata must appear before side headers and hunks');
          current.metadataMalformed = true;
          continue;
        }
        current.renameTo.push(parseSingleGitPath(line.slice('rename to '.length)));
      } else if (line.startsWith('copy from ')) {
        if (current.phase !== 'metadata' || current.sawPatchContent) {
          diagnostics.push('diff ordering: copy metadata must appear before side headers and hunks');
          current.metadataMalformed = true;
          continue;
        }
        current.copyFrom.push(parseSingleGitPath(line.slice('copy from '.length)));
      } else if (line.startsWith('copy to ')) {
        if (current.phase !== 'metadata' || current.sawPatchContent) {
          diagnostics.push('diff ordering: copy metadata must appear before side headers and hunks');
          current.metadataMalformed = true;
          continue;
        }
        current.copyTo.push(parseSingleGitPath(line.slice('copy to '.length)));
      } else if (line.startsWith('\\ No newline')) {
        if (current.phase !== 'hunk') {
          diagnostics.push('diff ordering: no-newline marker must appear inside a hunk');
          current.metadataMalformed = true;
        }
        continue;
      } else if (line.startsWith('-')) {
        current.sawPatchContent = true;
        if (current.phase !== 'hunk') {
          diagnostics.push('diff ordering: removed content is only valid inside an @@ hunk');
          current.metadataMalformed = true;
          continue;
        }
        current.oldLines.push(line.slice(1));
        current.removedContentCount += 1;
      } else if (line.startsWith('+')) {
        current.sawPatchContent = true;
        if (current.phase !== 'hunk') {
          diagnostics.push('diff ordering: added content is only valid inside an @@ hunk');
          current.metadataMalformed = true;
          continue;
        }
        current.newLines.push(line.slice(1));
        current.addedContentCount += 1;
      } else if (line.startsWith(' ')) {
        current.sawPatchContent = true;
        if (current.phase !== 'hunk') {
          diagnostics.push('diff ordering: context content is only valid inside an @@ hunk');
          current.metadataMalformed = true;
          continue;
        }
        current.oldLines.push(line.slice(1));
        current.newLines.push(line.slice(1));
      } else if (/^(?:Binary files .* differ|GIT binary patch)$/.test(line)) {
        if (current.phase !== 'metadata') {
          diagnostics.push('diff ordering: binary marker must appear before textual side headers or hunks');
          current.metadataMalformed = true;
        } else {
          current.phase = 'binary';
        }
      } else if (/^(?:old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|index)\b/.test(line)) {
        if (current.phase !== 'metadata' || current.sawPatchContent) {
          diagnostics.push('diff ordering: mode/index/similarity metadata must appear before side headers and hunks');
          current.metadataMalformed = true;
        }
      }
    } catch (error) {
      diagnostics.push(`diff path: ${error instanceof Error ? error.message : String(error)}`);
      current.metadataMalformed = true;
    }
  }
  flush();
  DIFF_SOURCE_DIAGNOSTICS.set(files, diagnostics);
  return files;
}

function normalizedTsSignature(node: ts.SignatureDeclarationBase, source: ts.SourceFile): string {
  const typeParameters = node.typeParameters?.map((parameter) => parameter.getText(source).replace(/\s+/g, ' ')).join(',') ?? '';
  const parameters = node.parameters.map((parameter) => parameter.getText(source).replace(/\s+/g, ' ')).join(',');
  const returnType = node.type?.getText(source).replace(/\s+/g, ' ') ?? '';
  const asyncFlag = ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async' : '';
  const generatorFlag = 'asteriskToken' in node && node.asteriskToken ? 'generator' : '';
  return `${asyncFlag}|${generatorFlag}|<${typeParameters}>|(${parameters})|${returnType}`;
}

function hasTsModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  let target = node;
  if (ts.isVariableDeclaration(node) && node.parent?.parent && ts.isVariableStatement(node.parent.parent)) {
    target = node.parent.parent;
  }
  return ts.canHaveModifiers(target) && Boolean(ts.getModifiers(target)?.some((modifier) => modifier.kind === kind));
}

function declarationName(node: ts.NamedDeclaration, source: ts.SourceFile): string | null {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
  if (ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text;
  const text = node.name.getText(source).trim();
  return text || null;
}

const TYPESCRIPT_DECLARATION_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;
const JAVASCRIPT_DECLARATION_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const PYTHON_DECLARATION_EXTENSION = /\.py(?:i|w)?$/i;

function isSupportedDeclarationPath(path: string): boolean {
  return TYPESCRIPT_DECLARATION_EXTENSION.test(path)
    || JAVASCRIPT_DECLARATION_EXTENSION.test(path)
    || PYTHON_DECLARATION_EXTENSION.test(path);
}

function scriptKindForDeclarationFile(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (JAVASCRIPT_DECLARATION_EXTENSION.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizeJsFamilySourceForParsing(sourceText: string): string {
  return sourceText.replace(/^(?:[ \t]*\n)+(?=#!)/, '');
}

function tsDeclarationContinuityKey(
  base: string,
  node: ts.SignatureDeclarationBase,
  source: ts.SourceFile,
  declarationOnly: boolean,
): string {
  return declarationOnly ? `${base}|signature|${normalizedTsSignature(node, source)}` : base;
}

function collectTsDeclarations(file: string, sourceText: string): { declarations: DeclarationIdentity[]; diagnostics: string[] } {
  const kind = scriptKindForDeclarationFile(file);
  const source = ts.createSourceFile(
    file,
    normalizeJsFamilySourceForParsing(sourceText),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const diagnostics = parseDiagnostics.map((diagnostic: ts.Diagnostic) => {
    const at = diagnostic.start === undefined ? '' : ` at ${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    return `${file}${at}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  const declarations: DeclarationIdentity[] = [];
  const visit = (node: ts.Node, scope: string[]) => {
    let childScope = scope;
    const exported = hasTsModifier(node, ts.SyntaxKind.ExportKeyword) ? 'export' : 'local';
    if (ts.isFunctionDeclaration(node) && node.name) {
      const base = `${file}|${scope.join('.') || '<module>'}|function|${node.name.text}`;
      declarations.push({
        name: node.name.text,
        continuityKey: tsDeclarationContinuityKey(base, node, source, node.body === undefined),
        key: `${file}|${scope.join('.') || '<module>'}|function|${node.name.text}|${exported}|${normalizedTsSignature(node, source)}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isClassDeclaration(node) && node.name) {
      declarations.push({
        name: node.name.text,
        continuityKey: `${file}|${scope.join('.') || '<module>'}|class|${node.name.text}`,
        key: `${file}|${scope.join('.') || '<module>'}|class|${node.name.text}|${exported}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      declarations.push({
        name: node.name.text,
        continuityKey: `${file}|${scope.join('.') || '<module>'}|const-arrow|${node.name.text}`,
        key: `${file}|${scope.join('.') || '<module>'}|const-arrow|${node.name.text}|${exported}|${normalizedTsSignature(node.initializer, source)}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = declarationName(node, source);
      const base = `${file}|${scope.join('.') || '<module>'}|method|${name}`;
      if (name) declarations.push({
        name,
        continuityKey: tsDeclarationContinuityKey(
          base,
          node,
          source,
          ts.isMethodSignature(node) || node.body === undefined,
        ),
        key: `${file}|${scope.join('.') || '<module>'}|method|${name}|${normalizedTsSignature(node, source)}`,
      });
      if (name) childScope = [...scope, name];
    } else if (ts.isConstructorDeclaration(node)) {
      const base = `${file}|${scope.join('.') || '<module>'}|constructor|constructor`;
      declarations.push({
        name: 'constructor',
        continuityKey: tsDeclarationContinuityKey(base, node, source, node.body === undefined),
        key: `${file}|${scope.join('.') || '<module>'}|constructor|constructor|${normalizedTsSignature(node, source)}`,
      });
      childScope = [...scope, 'constructor'];
    }
    ts.forEachChild(node, (child) => visit(child, childScope));
  };
  visit(source, []);
  return { declarations, diagnostics };
}

function pythonHeaderComplete(header: string): { complete: boolean; malformed: boolean; end: number } {
  const stack: string[] = [];
  let quote = '';
  let escaped = false;
  let comment = false;
  for (let offset = 0; offset < header.length; offset += 1) {
    const character = header[offset]!;
    if (character === '\n') {
      comment = false;
      continue;
    }
    if (comment) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') {
      comment = true;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (stack.pop() !== expected) return { complete: false, malformed: true, end: -1 };
    } else if (character === ':' && stack.length === 0) {
      return { complete: true, malformed: false, end: offset };
    }
  }
  return { complete: false, malformed: false, end: -1 };
}

function collectPythonDeclarations(file: string, sourceText: string): { declarations: DeclarationIdentity[]; diagnostics: string[] } {
  const declarations: DeclarationIdentity[] = [];
  const scopes: Array<{ indent: number; name: string }> = [];
  const diagnostics: string[] = [];
  const lines = sourceText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indentText = line.match(/^[ \t]*/)?.[0] ?? '';
    if (indentText.includes('\t')) {
      diagnostics.push(`${file} at ${index + 1}: tab-indented Python declaration scope is ambiguous`);
      continue;
    }
    const indent = indentText.length;
    while (scopes.length && scopes.at(-1)!.indent >= indent) scopes.pop();
    const start = /^\s*(?:(async)\s+)?(def|class)\s+([A-Za-z_]\w*)\b(.*)$/.exec(line);
    if (!start) {
      if (/^\s*(?:async\s+)?(?:def|class)\b/.test(line)) {
        diagnostics.push(`${file} at ${index + 1}: malformed Python declaration header`);
      }
      continue;
    }
    const [, asyncFlag, kind, name] = start;
    const headerLines = [line.trim()];
    let completion = pythonHeaderComplete(headerLines.join('\n'));
    let endIndex = index;
    while (!completion.complete && !completion.malformed && endIndex + 1 < lines.length) {
      const next = lines[endIndex + 1]!;
      if (/^\s*(?:async\s+)?(?:def|class)\b/.test(next) && (next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      endIndex += 1;
      headerLines.push(next.trim());
      completion = pythonHeaderComplete(headerLines.join('\n'));
    }
    if (!completion.complete || completion.malformed) {
      diagnostics.push(`${file} at ${index + 1}: malformed or unterminated Python ${kind} header`);
      index = endIndex;
      continue;
    }
    index = endIndex;
    const completeHeader = headerLines.join('\n');
    const signature = completeHeader.slice(0, completion.end)
      .replace(/^(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const scope = scopes.map((entry) => entry.name).join('.') || '<module>';
    declarations.push({
      name: name!,
      continuityKey: `${file}|${scope}|py-${kind}|${name}`,
      key: `${file}|${scope}|py-${kind}|${name}|${asyncFlag ? 'async' : ''}|${signature}`,
    });
    scopes.push({ indent, name: name! });
  }
  return { declarations, diagnostics };
}

function isConceptAnalyzablePath(path: string): boolean {
  return PYTHON_DECLARATION_EXTENSION.test(path)
    || TYPESCRIPT_DECLARATION_EXTENSION.test(path)
    || JAVASCRIPT_DECLARATION_EXTENSION.test(path);
}

export function analyzeDeletedSymbols(diff: string, projectRoot?: string): DeletedSymbolAnalysis {
  const removed = new Map<string, DeclarationIdentity[]>();
  const added = new Map<string, number>();
  const reconstructed = diffFileSources(diff);
  const diagnostics: string[] = [...(DIFF_SOURCE_DIAGNOSTICS.get(reconstructed) ?? [])];
  const skipped = new Set<string>();
  // Language-neutral (B-956f): resolve the material-code policy once so the skip
  // channel names ONLY material-code files in a source language concept analysis
  // cannot parse (non-TS/py) — not docs, and not manifests without a code
  // extension (go.mod, package.json). CX4 FIX F: `projectRoot` is threaded from
  // the caller (checkConcept passes deps.projectRoot) so PROJECT CONFIG is
  // honored — a configured-nonmaterial experiments/model.rs must not be
  // reported as skipped-material. Fails soft: a malformed policy (surfaced
  // fail-closed by the resolve/floor/repro gates) yields no skip diagnostics
  // here.
  let policy: ReturnType<typeof resolveMaterialCodePolicy> | undefined;
  try {
    policy = resolveMaterialCodePolicy(projectRoot);
  } catch {
    policy = undefined;
  }
  const noteSkip = (path: string): void => {
    if (!path || path === '/dev/null' || isConceptAnalyzablePath(path)) return;
    if (!policy) return;
    const ext = materialPathExtension(path);
    if (!ext || !policy.codeExtensions.includes(ext)) return;
    if (!classifyMaterialCodePath(policy, path, projectRoot !== undefined ? { projectRoot } : {}).materialCode) return;
    skipped.add(path.replace(/\\/g, '/'));
  };
  for (const file of reconstructed) {
    const collectSide = (path: string, source: string) => {
      if (PYTHON_DECLARATION_EXTENSION.test(path)) {
        return collectPythonDeclarations(path, source);
      }
      if (
        TYPESCRIPT_DECLARATION_EXTENSION.test(path)
        || JAVASCRIPT_DECLARATION_EXTENSION.test(path)
      ) {
        return collectTsDeclarations(path, source);
      }
      return { declarations: [], diagnostics: [] };
    };
    noteSkip(file.newPath);
    if (!file.copy) noteSkip(file.oldPath);
    const oldSide = file.copy
      ? { declarations: [], diagnostics: [] }
      : collectSide(file.oldPath, file.oldSource);
    const newSide = collectSide(file.newPath, file.newSource);
    diagnostics.push(...oldSide.diagnostics, ...newSide.diagnostics);
    for (const declaration of oldSide.declarations) {
      removed.set(
        declaration.continuityKey,
        [...(removed.get(declaration.continuityKey) ?? []), declaration],
      );
    }
    for (const declaration of newSide.declarations) {
      added.set(
        declaration.continuityKey,
        (added.get(declaration.continuityKey) ?? 0) + 1,
      );
    }
  }
  const symbols: string[] = [];
  for (const [key, declarations] of removed) {
    const survivorCount = added.get(key) ?? 0;
    for (const declaration of declarations.slice(survivorCount)) symbols.push(declaration.name);
  }
  return {
    symbols: [...new Set(symbols)].sort(),
    diagnostics: [...new Set(diagnostics)].sort(),
    skipDiagnostics: [...skipped].sort().map((path) => `concept-analysis skipped ${path} (non-TS/py source; deleted-symbol analysis unsupported)`),
  };
}

export function scanDeletedSymbols(diff: string, projectRoot?: string): string[] {
  return analyzeDeletedSymbols(diff, projectRoot).symbols;
}

/** B-956f: the DISTINCT concept-analysis skip diagnostic channel for a diff. */
export function conceptSkipDiagnostics(diff: string, projectRoot?: string): string[] {
  return analyzeDeletedSymbols(diff, projectRoot).skipDiagnostics;
}

// ── residual grep ──

/**
 * Parse the output of `grep -rn` into { file, line, snippet }.
 * In the form `./path/to/file.ts:42:snippet content`
 */
export function parseGrepLine(
  raw: string,
  symbol: string,
): Omit<ConceptResidual, 'symbol'> | null {
  const trimmed = raw.replace(/\r$/, '');
  if (!trimmed) return null;
  // file:line:content  — file can contain `:` (unlikely on unix), but simply take the first two `:`
  const firstColon = trimmed.indexOf(':');
  if (firstColon < 0) return null;
  const file = trimmed.slice(0, firstColon);
  const rest = trimmed.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon < 0) return null;
  const lineNumStr = rest.slice(0, secondColon);
  const lineNum = Number.parseInt(lineNumStr, 10);
  if (!Number.isFinite(lineNum)) return null;
  const snippet = rest.slice(secondColon + 1).trim();
  // strip leading "./" from file for consistency
  const cleanFile = file.startsWith('./') ? file.slice(2) : file;
  // Note: we intentionally do NOT require the snippet to contain the symbol.
  // grep has already filtered; a match could span multiple lines (e.g. the
  // symbol appears on a different line than the `grep -n` reported line when
  // context flags are used). Report whatever grep gave us.
  return { file: cleanFile, line: lineNum, snippet };
}

/**
 * Grep the entire repo for each symbol, merging all hits as residuals.
 * Self-reference protection: skip files that appear in the diff itself (hits on the current symbol in diff-changed files
 * are likely "still within diff scope" rather than true residuals; true residuals are determined by code body lines).
 *
 * Simplified version: node_modules/dist/.git/tmp/.worktrees are already excluded at the grep level,
 * no secondary file path filtering is done here.
 */
export function grepResiduals(
  symbols: string[],
  deps: { projectRoot: string; grepReader?: GrepReader },
): ConceptResidual[] {
  const grepReader = deps.grepReader ?? defaultGrepReader;
  const out: ConceptResidual[] = [];
  for (const symbol of symbols) {
    let raw: string;
    try {
      raw = grepReader({ symbol, projectRoot: deps.projectRoot });
    } catch {
      // grep failure treated as no residuals for that symbol (does not block other symbols)
      continue;
    }
    for (const line of raw.split('\n')) {
      const parsed = parseGrepLine(line, symbol);
      if (!parsed) continue;
      if (isIgnoredResidualFile(parsed.file)) continue;
      out.push({ symbol, ...parsed });
    }
  }
  return out;
}

// ── main entry ──

export interface CheckConceptDeps {
  projectRoot: string;
  /**
   * B-2856: cwd for the git diff + repo-wide grep child processes. In a
   * wrapper-root layout the caller resolves the gitRoot via resolveGitCwd() and
   * threads it here so both the diff and the grep scan run from the gitRoot.
   * Defaults to projectRoot, keeping plain repos byte-identical.
   */
  gitCwd?: string;
  gitDiffReader?: GitDiffReader;
  grepReader?: GrepReader;
  base?: string;
}

/**
 * Core entry point: read diff → extract deleted symbols → grep residuals → determine status + recommendation.
 *
 * Note: does not depend on StoryStore; story existence is validated by the caller (verifier handler) at the CLI layer.
 * The story argument is passed purely for future per-story diff base extension; the current base defaults to "main".
 */
export function checkConcept(deps: CheckConceptDeps): ConceptCheckResult {
  const {
    projectRoot,
    gitDiffReader = defaultGitDiffReader,
    grepReader,
    base = DEFAULT_BASE,
  } = deps;
  // B-2856: run git diff + grep from the resolved gitRoot (wrapper-root) or fall
  // back to projectRoot (plain repo). Default keeps existing behavior identical.
  const gitCwd = deps.gitCwd ?? projectRoot;

  let diff: string;
  try {
    diff = gitDiffReader({ base, projectRoot: gitCwd });
  } catch (e: any) {
    // git diff failure (no base, orphan branch, detached HEAD, etc.): don't
    // silently pass — surface as warn so the preflight log shows the problem,
    // but also don't fail outright (no diff → nothing to verify; e.g. orphan
    // branch case). recommendation=skip since we couldn't compute residuals.
    return {
      provider: 'proof-or-stop-concept',
      status: 'warn',
      summary: `git diff failed (${base}...HEAD): ${String(e?.message ?? e)}`,
      deletedSymbols: [],
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  // CX4 FIX F: thread deps.projectRoot (the CONFIG root, distinct from gitCwd)
  // so the skip channel honors the project's materialCode config in production.
  const analysis = analyzeDeletedSymbols(diff, projectRoot);
  // B-956f: the concept skip channel is its OWN diagnostic, surfaced alongside
  // every outcome without ever being conflated with the fail-closed parse
  // `diagnostics` (a language skip must not fail the gate).
  const skip = analysis.skipDiagnostics.length > 0 ? { skipDiagnostics: analysis.skipDiagnostics } : {};
  if (analysis.diagnostics.length > 0) {
    return {
      provider: 'proof-or-stop-concept',
      status: 'fail',
      summary: `declaration diff parse failed closed: ${analysis.diagnostics[0]}`,
      deletedSymbols: analysis.symbols,
      residuals: [],
      diagnostics: analysis.diagnostics,
      ...skip,
      recommendation: 'dispatch proof-or-stop-review-concept',
    };
  }
  const symbols = analysis.symbols;
  if (symbols.length === 0) {
    return {
      provider: 'proof-or-stop-concept',
      status: 'pass',
      summary: `no deleted exports in ${base}...HEAD`,
      deletedSymbols: [],
      residuals: [],
      ...skip,
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const residuals = grepResiduals(symbols, { projectRoot: gitCwd, grepReader });

  if (residuals.length === 0) {
    return {
      provider: 'proof-or-stop-concept',
      status: 'pass',
      summary: `${symbols.length} symbol(s) deleted, no residual references`,
      deletedSymbols: symbols,
      residuals: [],
      ...skip,
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const recommendation: ConceptCheckResult['recommendation'] =
    residuals.length >= 5 ? 'dispatch proof-or-stop-review-concept' : 'skip concept LLM reviewer';

  // F-017: residuals ≥ 5 → status=fail (blocks CLI gate and renders ✗ fail),
  // residuals 1..4 → status=warn (preserves original semantics, suggests skip reviewer, non-blocking)
  const status: ConceptCheckResult['status'] = residuals.length >= 5 ? 'fail' : 'warn';

  return {
    provider: 'proof-or-stop-concept',
    status,
    summary: `${symbols.length} symbol(s) deleted, ${residuals.length} residual reference(s) found`,
    deletedSymbols: symbols,
    residuals,
    ...skip,
    recommendation,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `proof-or-stop validate --concept`.
 *
 * Does not spawn pytest / does not run full validate.ts — directly calls checkConcept, outputs
 * structured results + human-readable rendering. Used for independent REVIEW→TEST preflight routing.
 *
 * Determination:
 *   - status=pass                        → ok
 *   - status=warn, residuals < 5         → ok (suggestion: skip LLM reviewer)
 *   - status=warn, residuals ≥ 5         → ok=false (suggestion: dispatch concept reviewer)
 *
 * Note: The CLI entry only returns CLI-level ok/fail; the reviewer-already-ran determination is done in review-preflight
 * (which has access to StoryStore).
 */
export interface ConceptCliResult {
  ok: boolean;
  result: ConceptCheckResult;
  rendered: string;
}

export function runConceptGateCli(deps: CheckConceptDeps): ConceptCliResult {
  const result = checkConcept(deps);
  let ok: boolean;
  if (result.status === 'pass') {
    ok = true;
  } else if (result.status === 'warn' && result.residuals.length < 5) {
    ok = true;
  } else {
    // residuals ≥ 5 (status='fail') / other statuses → CLI layer reports fail
    ok = false;
  }
  return { ok, result, rendered: renderConceptResult(result) };
}

/** Render ConceptCheckResult as human-readable text */
export function renderConceptResult(r: ConceptCheckResult): string {
  const lines: string[] = [];
  // F-017: fail shows ✗, warn shows ⚠, pass shows ✓
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⚠';
  lines.push(`[concept] ${icon} ${r.status}: ${r.summary}`);
  if (r.deletedSymbols.length > 0) {
    lines.push(`  deletedSymbols: ${r.deletedSymbols.join(', ')}`);
  }
  if (r.residuals.length > 0) {
    lines.push(`  residuals (${r.residuals.length}):`);
    for (const res of r.residuals.slice(0, 20)) {
      lines.push(`    ${res.symbol} @ ${res.file}:${res.line}`);
    }
    if (r.residuals.length > 20) {
      lines.push(`    ... (${r.residuals.length - 20} more)`);
    }
  }
  for (const diagnostic of r.diagnostics ?? []) lines.push(`  diagnostic: ${diagnostic}`);
  lines.push(`  recommendation: ${r.recommendation}`);
  if (r.status === 'fail') {
    lines.push('  note: standalone validate --concept only reports raw residuals; REVIEW→TEST preflight may accept them after proof-or-stop-review-concept records a finding or review_pass_set in the current review round.');
  }
  return lines.join('\n');
}
