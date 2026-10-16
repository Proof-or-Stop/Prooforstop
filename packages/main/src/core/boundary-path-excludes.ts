/**
 * Lab run110 (bench-staging/oldpos/run110-analysis.md §4 gap 1, §6 fix 1): the Story's user-confirmed scope boundary
 * (scope-boundary.json, story_create) said `"excluded": ["changes to docs", ...]`, but that prose never reached the scope
 * contract: the gate admitted documentation by default (scope-path-classifier documentation-default) and the managed
 * repair prompt told every worker "documentation files are admitted by the gate too: edit and commit it". The docs lane's
 * drift finding was repaired by editing the docs, three other lanes reported that edit as a scope-boundary violation,
 * its revert re-created the drift: 6 review rounds, timeout.
 *
 * boundaryPathExcludes maps the boundary's `excluded` entries that state a PATH CLASS to explicitExcludes patterns, so
 * the writer prompt (core/managed-writer-scope.ts), the write-time guard (managedWriterScopeViolations) and the REVIEW
 * scope gate (classifyScopePath: explicitExcludes precede the documentation default) agree:
 *
 *   - documentation: an entry made only of documentation words ("docs", "documentation", "README", "changelog", ...)
 *     and filler ("changes to", "updates", "any", "files", ...) maps to DOCUMENTATION_EXCLUDE_PATTERN. An entry that
 *     says more ("docs for unrelated types") is not a path class and is left to the reviewers, as before;
 *   - a path token (`vendor/`, `eval/legacy.go`) that exists in the repository maps to that path.
 *
 * Precedence (request text > scope boundary > reviewer opinion): documentation stays admitted when the request asks for
 * documentation work (requestAsksDocsChange), when an allowed contract path is a documentation file, or when a boundary
 * `allowed` entry is about documentation; a path token never excludes a path the contract allows.
 *
 * Production default on; `scope.boundaryExcludes=off` (core/ab-variants.ts) is the recorded rollback.
 */
import { DOCS_WORK } from './finding-preexisting.js';
import { isDocumentationPath, normalizeScopePath, pathMatchesScopePattern } from './scope-path-classifier.js';

/** Every documentation file the scope gate would otherwise admit by default (.md, .mdx, .rst, .adoc at any depth). */
export const DOCUMENTATION_EXCLUDE_PATTERN = '**/*.{md,mdx,rst,adoc}';

const DOC_WORDS = new Set(['doc', 'docs', 'documentation', 'documentations', 'readme', 'readmes', 'markdown', 'changelog', 'changelogs',
  'guide', 'guides', 'manual', 'manuals', 'md', 'mdx', 'rst', 'adoc', 'docstring', 'docstrings', 'wiki']);
const FILLER = new Set(['change', 'changes', 'changing', 'edit', 'edits', 'editing', 'update', 'updates', 'updating', 'modification',
  'modifications', 'modify', 'modifying', 'rewrite', 'rewrites', 'rewriting', 'touching', 'touch', 'to', 'the', 'any', 'of', 'in', 'on',
  'no', 'other', 'and', 'or', 'file', 'files', 'page', 'pages', 'project', 'user', 'facing', 'user-facing', 'related', 'existing',
  'example', 'examples', 'text', 'content', 'contents', 'a', 'an', 'for', 'all', 'its', 'their', 'not', 'without', 'additional',
  'new', 'extra', 'further', 'documentation-only', 'docs-only']);
const PATH_TOKEN = /^(?:[\w.-]+\/)+[\w.*-]*$|^[\w-]+\.[A-Za-z][\w]{0,5}$/;
/** An imperative change verb in the sentence that names a documentation path. */
const CHANGE_VERB = /\b(?:update|correct|fix|rewrite|revise|edit|change|amend|document|add|extend|write)s?\b/i;
const DOC_PATH = /(?<![\w.-])(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|rst|adoc)\b/i;

export interface BoundaryPathExcludes {
  /** explicitExcludes patterns to add (deduplicated, in derivation order). */
  patterns: string[];
  /** Which boundary entry produced which pattern (audit). */
  sources: Array<{ entry: string; pattern: string }>;
  /** Entries that named a path class but were kept admitted, and why (audit). */
  kept: Array<{ entry: string; reason: string }>;
}

const words = (text: string): string[] => text.toLowerCase().replace(/[`"'()[\],;:.!?]/g, ' ').split(/\s+/).filter(Boolean);

/** A boundary entry made only of documentation words and filler ("changes to docs", "README or docs updates"). */
export function isDocumentationOnlyEntry(entry: string): boolean {
  const tokens = words(entry);
  return tokens.some(token => DOC_WORDS.has(token)) && tokens.every(token => DOC_WORDS.has(token) || FILLER.has(token));
}

/** The request asks for documentation work: the docs-work imperative, or a change verb in a sentence naming a doc path. */
export function requestAsksDocsChange(requestText: string | null | undefined): string | null {
  const text = requestText ?? '';
  const work = text.match(DOCS_WORK)?.[0];
  if (work) return work.trim();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (DOC_PATH.test(sentence) && CHANGE_VERB.test(sentence) && !/\bas (?:documented|described|specified) in\b/i.test(sentence)) return sentence.trim();
  }
  return null;
}

/** The request asks to change `path` (a documentation path: requestAsksDocsChange; any path: a change verb in a sentence naming it). */
export function requestAsksChangeOf(requestText: string | null | undefined, path: string): string | null {
  const text = requestText ?? '';
  const base = path.split('/').pop()!.toLowerCase();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const lower = sentence.toLowerCase();
    if ((lower.includes(path.toLowerCase()) || lower.includes(base)) && CHANGE_VERB.test(sentence)
      && !/\bas (?:documented|described|specified) in\b/i.test(sentence)) return sentence.trim();
  }
  return isDocumentationPath(normalizeScopePath(path)) ? (text.match(DOCS_WORK)?.[0]?.trim() ?? null) : null;
}

/**
 * The explicitExcludes patterns the boundary's excluded entries state. `allowedPaths` are the contract's allowed
 * modify / create / test entries; `pathExists` answers whether a path token names a file or directory in the repo.
 */
export function boundaryPathExcludes(args: { excluded: readonly string[]; allowed?: readonly string[]; allowedPaths: readonly string[];
  requestText?: string | null; pathExists?: (path: string) => boolean }): BoundaryPathExcludes {
  const out: BoundaryPathExcludes = { patterns: [], sources: [], kept: [] };
  const add = (entry: string, pattern: string) => {
    if (!out.patterns.includes(pattern)) out.patterns.push(pattern);
    out.sources.push({ entry, pattern });
  };
  for (const entry of args.excluded) {
    if (isDocumentationOnlyEntry(entry)) {
      const requested = requestAsksDocsChange(args.requestText);
      const allowedDoc = args.allowedPaths.find(path => isDocumentationPath(normalizeScopePath(path)));
      const allowedEntry = (args.allowed ?? []).find(row => words(row).some(token => DOC_WORDS.has(token)));
      if (requested) out.kept.push({ entry, reason: `the request asks for documentation work ("${requested}")` });
      else if (allowedDoc) out.kept.push({ entry, reason: `the scope contract allows the documentation file ${allowedDoc}` });
      else if (allowedEntry) out.kept.push({ entry, reason: `the scope boundary allows "${allowedEntry}"` });
      else add(entry, DOCUMENTATION_EXCLUDE_PATTERN);
      continue;
    }
    for (const raw of entry.split(/[\s,;]+/)) {
      const cleaned = raw.replace(/^[`"'(]+|[`"'),.:;]+$/g, '');
      const token = normalizeScopePath(cleaned);
      if (!token || !PATH_TOKEN.test(cleaned) || /^\.+$/.test(token)) continue;
      if (!args.pathExists?.(token)) continue;
      if (args.allowedPaths.some(path => pathMatchesScopePattern(path, token) || pathMatchesScopePattern(token, path))) {
        out.kept.push({ entry, reason: `${token} is an allowed contract path` });
        continue;
      }
      add(entry, token);
    }
  }
  return out;
}

/** Whether the contract's explicitExcludes / protectedFiles keep documentation files out (a sample doc path matches). */
export function contractExcludesDocumentation(contract: { explicitExcludes?: readonly string[]; protectedFiles?: readonly string[] } | null | undefined): string | null {
  const patterns = [...(contract?.explicitExcludes ?? []), ...(contract?.protectedFiles ?? [])];
  return patterns.find(pattern => ['docs/guide.md', 'README.md'].every(path => pathMatchesScopePattern(path, pattern))) ?? null;
}
