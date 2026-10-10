#!/usr/bin/env node
/**
 * Strip every comment from the JavaScript and declaration files of a staged
 * (shipped) package: dist/**\/*.{js,mjs,cjs,d.ts}. Benchmark bundle hygiene
 * (bench-staging/oldpos/run40-analysis.md §4): framework comments carry the
 * development history of the code (which benchmark run motivated a rule), and
 * the bundle ships it to every agent that reads the installed runtime. The
 * repository keeps its comments; only the staged copy is stripped.
 *
 * Exact: comment ranges come from the TypeScript parser (the leading and
 * trailing trivia of every token, so a `//` or `/*` inside a string, template or regular
 * expression is never touched); a removed block comment keeps its newlines
 * (line numbers and automatic semicolon insertion are unchanged) and is
 * otherwise replaced by one space; the shebang stays.
 *
 * Identity boundaries: the runtime verifies some of its own files
 * (core/runtime-environment-checks.js, assertCanonicalActiveIdentityBoundary).
 * Every boundary that passes on the staged package before the strip must still
 * pass after it; a boundary that would break gets its files restored (and is
 * reported), so the strip can never make the installed runtime refuse itself.
 *
 * Usage: node scripts/strip-shipped-comments.mjs --package-root DIR [--no-identity-check]
 * Prints one JSON line: { files, strippedFiles, bytesBefore, bytesAfter, identity }.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function parseArgs(argv) {
  const options = { packageRoot: null, identity: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--package-root') options.packageRoot = resolve(argv[++i]);
    else if (argv[i] === '--no-identity-check') options.identity = false;
    else throw new Error(`strip-shipped-comments: unknown argument ${argv[i]}`);
  }
  if (!options.packageRoot) throw new Error('strip-shipped-comments: --package-root DIR is required');
  return options;
}

const SHIPPED = /\.(?:m?js|cjs)$|\.d\.ts$/;
const isJsDoc = node => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/** Every comment range of a source text, from the leading trivia of each token (and the end of file). */
export function commentRanges(text, fileName) {
  const kind = /\.d\.ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const seen = new Map();
  const add = (ranges) => { for (const range of ranges ?? []) seen.set(range.pos, range); };
  const visit = node => {
    if (isJsDoc(node)) return;
    const children = node.getChildren(source);
    if (!children.length || node.kind === ts.SyntaxKind.EndOfFileToken) {
      // Leading trivia holds the comments after a line break; a same-line comment after a token is its trailing trivia.
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of children) visit(child);
  };
  visit(source);
  add(ts.getLeadingCommentRanges(text, source.endOfFileToken.pos));
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/** Comments naming the development history (a benchmark run): the minimum strip for identity-bound files. */
export const RUN_HISTORY = /\bold-PoS\b|\bOld-PoS\b|\b[Rr]uns? \d{1,2}\b(?![-.]\d)/;

/** The text with every comment (or, with `only`, every comment matching it) removed; block comments keep their newlines. */
export function stripComments(text, fileName, only = null) {
  const ranges = commentRanges(text, fileName).filter(range => !only || only.test(text.slice(range.pos, range.end)));
  if (!ranges.length) return text;
  let out = '';
  let at = 0;
  for (const range of ranges) {
    if (range.pos < at) continue;
    out += text.slice(at, range.pos);
    const comment = text.slice(range.pos, range.end);
    const newlines = comment.match(/\r?\n/g);
    out += range.kind === ts.SyntaxKind.MultiLineCommentTrivia ? (newlines ? newlines.join('') : ' ') : '';
    at = range.end;
  }
  out += text.slice(at);
  return out;
}

function shippedFiles(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (SHIPPED.test(name)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * Boundary id -> ok / error message for the staged package's files (null: no checker). The checker
 * module is this checkout's build (the same code the staged copy was taken from, with its own
 * dependencies), falling back to the staged one; it reads the staged files from runtimePackageRoot.
 */
async function identityStatus(packageRoot, projectRoot) {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'main', 'dist', 'core', 'runtime-environment-checks.js');
  const staged = join(packageRoot, 'dist', 'core', 'runtime-environment-checks.js');
  if (!existsSync(staged)) return null;
  const checker = existsSync(source) ? source : staged;
  // A fresh module instance per check: the checker caches digests by text, never by path state.
  const module = await import(`${pathToFileURL(checker).href}?t=${Date.now()}-${Math.random()}`);
  const status = new Map();
  for (const boundary of module.ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    try { module.assertCanonicalActiveIdentityBoundary({ boundaryId: boundary.id, runtimePackageRoot: packageRoot, projectRoot }); status.set(boundary.id, { ok: true, paths: boundary.paths }); }
    catch (error) { status.set(boundary.id, { ok: false, error: String(error?.message ?? error), paths: boundary.paths }); }
  }
  return status;
}

export async function stripShippedComments(packageRoot, options = { identity: true }) {
  const dist = join(packageRoot, 'dist');
  const projectRoot = mkdtempSync(join(tmpdir(), 'strip-comments-project-'));
  try {
    const before = options.identity ? await identityStatus(packageRoot, projectRoot) : null;
    const originals = new Map();
    let bytesBefore = 0;
    let bytesAfter = 0;
    for (const file of shippedFiles(dist)) {
      const text = readFileSync(file, 'utf8');
      const stripped = stripComments(text, file);
      bytesBefore += Buffer.byteLength(text);
      bytesAfter += Buffer.byteLength(stripped);
      if (stripped === text) continue;
      originals.set(file, text);
      writeFileSync(file, stripped);
    }
    const restored = [];
    const historyOnly = [];
    let identity = 'not checked';
    if (before) {
      // A boundary the full strip breaks (its checker counts identity tokens in the raw bytes, comments
      // included): its files get only the run-history comments stripped; if that still breaks, they are restored.
      const brokenFiles = (status) => [...before].filter(([id, row]) => row.ok && !status.get(id)?.ok)
        .flatMap(([, row]) => (row.paths ?? []).filter(entry => entry.scope === 'runtime-package').map(entry => resolve(packageRoot, entry.path)))
        .filter(file => originals.has(file));
      let broken = brokenFiles(await identityStatus(packageRoot, projectRoot));
      for (const file of broken) {
        const minimal = stripComments(originals.get(file), file, RUN_HISTORY);
        writeFileSync(file, minimal);
        historyOnly.push(relative(packageRoot, file));
      }
      if (broken.length) broken = brokenFiles(await identityStatus(packageRoot, projectRoot));
      for (const file of broken) {
        writeFileSync(file, originals.get(file));
        originals.delete(file);
        restored.push(relative(packageRoot, file));
      }
      const final = await identityStatus(packageRoot, projectRoot);
      const still = [...before].filter(([id, row]) => row.ok && !final.get(id)?.ok).map(([id]) => `${id}: ${final.get(id)?.error ?? 'missing'}`);
      if (still.length) throw new Error(`strip-shipped-comments: identity boundaries broken by the strip:\n${still.join('\n')}`);
      identity = `${[...before.values()].filter(row => row.ok).length} boundaries valid before and after`;
    }
    bytesAfter = shippedFiles(dist).reduce((sum, file) => sum + statSync(file).size, 0);
    return { files: originals.size + restored.length, strippedFiles: originals.size, historyOnly: historyOnly.filter(file => !restored.includes(file)), restored, bytesBefore, bytesAfter, identity };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await stripShippedComments(options.packageRoot, { identity: options.identity });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
