/**
 * validate-concept — CLI gate: deleted-symbol residual check
 *
 * Extract deleted declarations (TS / Python) from `git diff main...HEAD`, then for each symbol
 * grep the entire repo, listing residual references that have not yet been cleaned up. Threshold 5:
 *
 * - residuals.length == 0     → status=pass, recommendation="skip concept LLM reviewer"
 * - 1 ≤ residuals.length < 5  → status=warn, recommendation="skip concept LLM reviewer"
 * - residuals.length ≥ 5      → status=warn, recommendation="dispatch lattice-review-concept"
 *
 * Output structure:
 *   {
 *     provider: "lattice-concept",
 *     status: "pass" | "warn",
 *     summary: string,
 *     deletedSymbols: string[],
 *     residuals: Array<{ symbol, file, line, snippet }>,
 *     recommendation: "skip concept LLM reviewer" | "dispatch lattice-review-concept"
 *   }
 *
 * See docs/reviewer-redesign.md §III S1 item 2.
 */

import { execSync } from 'node:child_process';
import ts from 'typescript';
import { DEFAULT_BASE } from './validate-shared.js';

export interface ConceptResidual {
  symbol: string;
  file: string;
  line: number;
  snippet: string;
}

export interface ConceptCheckResult {
  // F-017 (B-9d95 Round 1 review): residuals ≥ 5 upgraded to fail (instead of warn),
  // aligned with the ok=false semantics returned by runConceptGateCli/CLI gate, rendering shows ✗ fail.
  provider: 'lattice-concept';
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  deletedSymbols: string[];
  residuals: ConceptResidual[];
  diagnostics?: string[];
  recommendation: 'skip concept LLM reviewer' | 'dispatch lattice-review-concept';
}

/** Readers can be injected for tests. Default uses `git diff main...HEAD`. */
export type GitDiffReader = (args: { base: string; projectRoot: string }) => string;

export type GrepReader = (args: {
  symbol: string;
  projectRoot: string;
}) => string;

/** Directories we never want to scan (would create false positives / self-reference) */
export const IGNORED_DIRS = [
  'node_modules',
  'dist',
  '.git',
  '.lattice',
  'tmp',
  '.worktrees',
];

const IGNORED_PATH_PREFIXES = [
  '.lattice/',
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
}

interface DeclarationIdentity {
  key: string;
  name: string;
}

interface DeletedSymbolAnalysis {
  symbols: string[];
  diagnostics: string[];
}

function diffFileSources(diff: string): DiffFileSources[] {
  const files: DiffFileSources[] = [];
  let current: { oldPath: string; newPath: string; oldLines: string[]; newLines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    files.push({
      oldPath: current.oldPath,
      newPath: current.newPath,
      oldSource: current.oldLines.join('\n'),
      newSource: current.newLines.join('\n'),
    });
  };
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = {
        oldPath: header[1]!,
        newPath: header[2]!,
        oldLines: [],
        newLines: [],
      };
      continue;
    }
    if (!current) {
      current = {
        oldPath: '__fragment__.ts',
        newPath: '__fragment__.ts',
        oldLines: [],
        newLines: [],
      };
    }
    if (line.startsWith('@@')) {
      current.oldLines.push('');
      current.newLines.push('');
    } else if (/^--- (?:a\/|\/dev\/null)/.test(line)) {
      current.oldPath = line.slice(4).replace(/^a\//, '');
    } else if (/^\+\+\+ (?:b\/|\/dev\/null)/.test(line)) {
      current.newPath = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('\\ No newline')) {
      continue;
    } else if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    }
  }
  flush();
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
const PYTHON_DECLARATION_EXTENSION = /\.py$/i;

function scriptKindForDeclarationFile(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (JAVASCRIPT_DECLARATION_EXTENSION.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizeJsFamilySourceForParsing(sourceText: string): string {
  return sourceText.replace(/^(?:[ \t]*\n)+(?=#!)/, '');
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
      declarations.push({
        name: node.name.text,
        key: `${file}|${scope.join('.') || '<module>'}|function|${node.name.text}|${exported}|${normalizedTsSignature(node, source)}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isClassDeclaration(node) && node.name) {
      declarations.push({
        name: node.name.text,
        key: `${file}|${scope.join('.') || '<module>'}|class|${node.name.text}|${exported}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      declarations.push({
        name: node.name.text,
        key: `${file}|${scope.join('.') || '<module>'}|const-arrow|${node.name.text}|${exported}|${normalizedTsSignature(node.initializer, source)}`,
      });
      childScope = [...scope, node.name.text];
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = declarationName(node, source);
      if (name) declarations.push({
        name,
        key: `${file}|${scope.join('.') || '<module>'}|method|${name}|${normalizedTsSignature(node, source)}`,
      });
      if (name) childScope = [...scope, name];
    } else if (ts.isConstructorDeclaration(node)) {
      declarations.push({
        name: 'constructor',
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
      key: `${file}|${scope}|py-${kind}|${name}|${asyncFlag ? 'async' : ''}|${signature}`,
    });
    scopes.push({ indent, name: name! });
  }
  return { declarations, diagnostics };
}

export function analyzeDeletedSymbols(diff: string): DeletedSymbolAnalysis {
  const removed = new Map<string, DeclarationIdentity[]>();
  const added = new Map<string, number>();
  const diagnostics: string[] = [];
  for (const file of diffFileSources(diff)) {
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
    const oldSide = collectSide(file.oldPath, file.oldSource);
    const newSide = collectSide(file.newPath, file.newSource);
    diagnostics.push(...oldSide.diagnostics, ...newSide.diagnostics);
    for (const declaration of oldSide.declarations) {
      removed.set(declaration.key, [...(removed.get(declaration.key) ?? []), declaration]);
    }
    for (const declaration of newSide.declarations) {
      added.set(declaration.key, (added.get(declaration.key) ?? 0) + 1);
    }
  }
  const symbols: string[] = [];
  for (const [key, declarations] of removed) {
    const survivorCount = added.get(key) ?? 0;
    for (const declaration of declarations.slice(survivorCount)) symbols.push(declaration.name);
  }
  return { symbols: [...new Set(symbols)].sort(), diagnostics: [...new Set(diagnostics)].sort() };
}

export function scanDeletedSymbols(diff: string): string[] {
  return analyzeDeletedSymbols(diff).symbols;
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
      provider: 'lattice-concept',
      status: 'warn',
      summary: `git diff failed (${base}...HEAD): ${String(e?.message ?? e)}`,
      deletedSymbols: [],
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const analysis = analyzeDeletedSymbols(diff);
  if (analysis.diagnostics.length > 0) {
    return {
      provider: 'lattice-concept',
      status: 'fail',
      summary: `declaration diff parse failed closed: ${analysis.diagnostics[0]}`,
      deletedSymbols: analysis.symbols,
      residuals: [],
      diagnostics: analysis.diagnostics,
      recommendation: 'dispatch lattice-review-concept',
    };
  }
  const symbols = analysis.symbols;
  if (symbols.length === 0) {
    return {
      provider: 'lattice-concept',
      status: 'pass',
      summary: `no deleted exports in ${base}...HEAD`,
      deletedSymbols: [],
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const residuals = grepResiduals(symbols, { projectRoot: gitCwd, grepReader });

  if (residuals.length === 0) {
    return {
      provider: 'lattice-concept',
      status: 'pass',
      summary: `${symbols.length} symbol(s) deleted, no residual references`,
      deletedSymbols: symbols,
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const recommendation: ConceptCheckResult['recommendation'] =
    residuals.length >= 5 ? 'dispatch lattice-review-concept' : 'skip concept LLM reviewer';

  // F-017: residuals ≥ 5 → status=fail (blocks CLI gate and renders ✗ fail),
  // residuals 1..4 → status=warn (preserves original semantics, suggests skip reviewer, non-blocking)
  const status: ConceptCheckResult['status'] = residuals.length >= 5 ? 'fail' : 'warn';

  return {
    provider: 'lattice-concept',
    status,
    summary: `${symbols.length} symbol(s) deleted, ${residuals.length} residual reference(s) found`,
    deletedSymbols: symbols,
    residuals,
    recommendation,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `lattice validate --concept`.
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
    lines.push('  note: standalone validate --concept only reports raw residuals; REVIEW→TEST preflight may accept them after lattice-review-concept records a finding or review_pass_set in the current review round.');
  }
  return lines.join('\n');
}
