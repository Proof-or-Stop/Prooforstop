/**
 * EXPERIMENTAL A/B `implementation.thread: "fresh"` (core/ab-variants.ts; plan
 * bench-staging/oldpos/v41-cost-plan.md item A1).
 *
 * Production (`resume`, the default): every managed implementer item and every
 * finding repair of a Story resumes ONE Codex thread (findResumableImplementerSession),
 * whose context grows from ~17k to 143–180k tokens over a run. With `fresh`
 * each implementer item and each finding repair starts a new Codex thread, and
 * host_run appends a compact, framework-built ITEM PACK to the dispatch prompt
 * so the fresh worker does not spend its first minute re-orienting:
 *   - request.md (verbatim, capped),
 *   - the other checklist items (one line each) and the Story commits so far,
 *   - the Story diff so far: stat (all material paths) + hunks of the files the
 *     item (or finding) declares,
 *   - those files at HEAD: full when small, else a definition outline with line
 *     numbers; for a repair also a window around every cited `file:line`,
 *   - for a repair: each bound finding (severity, evidence state, files) and the
 *     pinned commands of the items it touches.
 * The item, its intents, the pinned selectors and test commands are already in
 * the base dispatch prompt and are not repeated. Every section has a byte cap,
 * so the pack is bounded (ITEM_PACK_MAX_BYTES). The worker contract and return
 * format are unchanged.
 *
 * The arm is decided once, at host_run submit, from the config; it is sealed in
 * the run spec as `managedDispatchTarget.abVariant.flags["implementation.thread"]`
 * and the worker reads only that (managedResumeSessionForSpec), so the prompt
 * pack and the fresh launch always go together. A malformed config keeps
 * production (resume, no pack).
 *
 * Finding repairs (adopted `remediation.thread: "fresh"`, the default since
 * old-PoS run 25: a fresh repair with this pack took 0.86M input / 2.4 min
 * against 2.8-3.9M for a repair resumed on the Story code-writer thread at
 * 10-16M context) get the same repair pack and a fresh thread without the
 * experimental switch; host_run appends the pack and the worker decides from
 * the same config (remediationThreadFresh in managed-host-run.ts), like
 * review.round2Lanes. `remediation.thread: "resume"` is the rollback. Implementer
 * items keep implementation.thread (default resume).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { resolveAbVariants } from './ab-variants.js';
export { dispatchTargetThreadFresh } from './ab-variants.js';
import { loadConfig } from './config.js';
import { resolveFullStoryBaseHead } from './review-incremental-context.js';
import type { StoryStore } from './store.js';
import { readStoryRequest } from './story-request.js';
import type { ChecklistItem, Finding } from './types.js';

export const ITEM_PACK_LIMITS = {
  requestBytes: 4096,
  historyBytes: 2048,
  findingsBytes: 4096,
  statBytes: 2048,
  diffBytes: 12288,
  filesBytes: 12288,
  /** A declared file at most this size is included whole; a larger one as an outline. */
  fullFileBytes: 6144,
  outlineLines: 60,
  citeWindowLines: 20,
  maxFiles: 8,
} as const;

/** Upper bound of a pack's section bodies plus its fixed framing (~38 KB, ~10k tokens). */
export const ITEM_PACK_MAX_BYTES = ITEM_PACK_LIMITS.requestBytes + ITEM_PACK_LIMITS.historyBytes + ITEM_PACK_LIMITS.findingsBytes
  + ITEM_PACK_LIMITS.statBytes + ITEM_PACK_LIMITS.diffBytes + ITEM_PACK_LIMITS.filesBytes + 2048;


/** Config arm: true only for an explicit, well-formed `implementation.thread: "fresh"`. */
export function implementationThreadFresh(root: string): boolean {
  try { return resolveAbVariants(loadConfig(root)).implementationThread === 'fresh'; } catch { return false; }
}



function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  } catch {
    return '';
  }
}

/** Keep whole lines up to `max` bytes; mark what was cut. */
export function capBytes(text: string, max: number, what: string): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  const marker = `[item pack: ${what} truncated at ${max} bytes of ${Buffer.byteLength(text, 'utf8')}; read the rest yourself if you need it]`;
  const budget = max - Buffer.byteLength(marker, 'utf8') - 1;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return [...kept, marker].join('\n');
}

const DEFINITION = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:func|def|class|interface|type|struct|enum|impl|fn|function|trait|module|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\(|function))\b/;

function safePath(root: string, path: string): string | null {
  const abs = resolve(root, path);
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep) ? abs : null;
}

function numbered(lines: string[], from: number, to: number): string {
  return lines.slice(from, to).map((line, index) => `${String(from + index + 1).padStart(5)}  ${line}`).join('\n');
}

/** One declared file at HEAD: whole when small, else outline (+ windows around cited lines). */
function renderFile(root: string, path: string, citedLines: readonly number[]): string | null {
  const abs = safePath(root, path);
  if (!abs || !existsSync(abs)) return `### ${path}\n(not present at HEAD)`;
  try {
    if (!statSync(abs).isFile()) return null;
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) return `### ${path}\n(binary file)`;
    const lines = text.split('\n');
    if (Buffer.byteLength(text, 'utf8') <= ITEM_PACK_LIMITS.fullFileBytes) {
      return `### ${path} (whole file, ${lines.length} lines)\n${numbered(lines, 0, lines.length)}`;
    }
    const outline = lines.flatMap((line, index) => DEFINITION.test(line) ? [`${String(index + 1).padStart(5)}  ${line.trimEnd()}`] : []);
    const parts = [`### ${path} (${lines.length} lines; outline of definitions${outline.length > ITEM_PACK_LIMITS.outlineLines ? `, first ${ITEM_PACK_LIMITS.outlineLines} of ${outline.length}` : ''})`,
      ...outline.slice(0, ITEM_PACK_LIMITS.outlineLines)];
    for (const cited of [...new Set(citedLines)].sort((a, b) => a - b).slice(0, 4)) {
      const from = Math.max(0, cited - 1 - ITEM_PACK_LIMITS.citeWindowLines), to = Math.min(lines.length, cited + ITEM_PACK_LIMITS.citeWindowLines);
      parts.push(`--- ${path}:${from + 1}-${to} (around cited line ${cited})`, numbered(lines, from, to));
    }
    return parts.join('\n');
  } catch {
    return null;
  }
}

/** `path:line` and bare path citations in finding text that name an existing repository file. */
export function citedFileLines(root: string, text: string): Map<string, number[]> {
  const cited = new Map<string, number[]>();
  for (const match of text.matchAll(/(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?/g)) {
    const path = match[1]!.replace(/^\.\//, '');
    const abs = safePath(root, path);
    if (!abs || !existsSync(abs)) continue;
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    const rows = cited.get(path) ?? [];
    if (match[2]) rows.push(Number(match[2]));
    cited.set(path, rows);
  }
  return cited;
}

function itemFiles(item: Pick<ChecklistItem, 'files'>): string[] {
  const files = item.files;
  return files ? [...new Set([...files.modify, ...files.create, ...files.test])] : [];
}

function storyBase(store: StoryStore, root: string, storyId: string): string | null {
  try {
    const base = resolveFullStoryBaseHead(store, root, storyId);
    if (base) return base;
  } catch { /* fall through */ }
  const mergeBase = git(root, ['merge-base', 'HEAD', 'main']).trim();
  return mergeBase || null;
}

export interface ImplementerItemPack {
  lines: string[];
  /** UTF-8 bytes of the rendered pack (lines joined by newlines). */
  bytes: number;
  sections: Record<string, number>;
}

/**
 * Build the pack for one implementer item (`itemId`) or one finding repair
 * (`findingIds`: the bound finding first, then any grouped members).
 */
export function buildImplementerItemPack(store: StoryStore, root: string, args: {
  storyId: string; itemId?: string | null; findingIds?: readonly string[];
  /** Which switch made this run fresh (header label); default = the experimental implementation.thread arm. */
  arm?: string;
}): ImplementerItemPack {
  const items = (() => { try { return store.readChecklist(args.storyId).items; } catch { return [] as ChecklistItem[]; } })();
  const allFindings = args.findingIds?.length ? (() => { try { return store.readFindings(args.storyId).findings; } catch { return [] as Finding[]; } })() : [];
  const item = args.itemId ? items.find(row => row.id === args.itemId) ?? null : null;
  const findings = (args.findingIds ?? []).map(id => allFindings.find(row => row.id === id)).filter((row): row is Finding => Boolean(row));
  const sections: Record<string, number> = {};
  const out: string[] = [];
  const add = (name: string, title: string, body: string) => {
    if (!body.trim()) return;
    const block = `## ${title}\n${body}`;
    sections[name] = Buffer.byteLength(block, 'utf8');
    out.push(block);
  };

  const request = readStoryRequest(store, args.storyId);
  if (request.status === 'ok') {
    add('request', `request.md (verbatim; it outranks the checklist intents; ${store.storyDirRel()}/${args.storyId}/request.md)`, capBytes(request.text.trim(), ITEM_PACK_LIMITS.requestBytes, 'request.md'));
  }

  const base = storyBase(store, root, args.storyId);
  const storyDir = store.storyDirRel().replace(/\/+$/, '');
  const material = ['--', '.', `:(exclude)${storyDir}`, ':(exclude).proof-or-stop'];
  const history = [
    ...items.filter(row => row.id !== item?.id).map(row => `- ${row.id} [${row.status}] ${row.title}`),
    ...(base ? git(root, ['log', '--format=  commit %h %s', `${base}..HEAD`, ...material]).trimEnd().split('\n').filter(Boolean) : []),
  ];
  add('history', 'Other checklist items and the Story commits so far (one line each)', capBytes(history.join('\n'), ITEM_PACK_LIMITS.historyBytes, 'history'));

  const cited = new Map<string, number[]>();
  if (findings.length) {
    const rows: string[] = [];
    for (const finding of findings) {
      const short = finding.id.startsWith(`${args.storyId}:`) ? finding.id.slice(args.storyId.length + 1) : finding.id;
      rows.push(`- ${short} [severity=${finding.severity ?? 'n/a'}, category=${finding.category ?? 'n/a'}, evidence=${finding.evidenceState ?? 'verified'}, reviewer=${finding.agent ?? 'n/a'}]${finding.files?.length ? ` files: ${finding.files.join(', ')}` : ''}`);
      rows.push(`  ${(finding.desc ?? '').replace(/\s+/g, ' ').trim()}`);
      for (const path of finding.files ?? []) if (!cited.has(path)) cited.set(path, []);
      for (const [path, lines] of citedFileLines(root, finding.desc ?? '')) cited.set(path, [...(cited.get(path) ?? []), ...lines]);
    }
    const touched = items.filter(row => itemFiles(row).some(path => cited.has(path)) || findings.some(f => (f.desc ?? '').includes(row.id)));
    const pins = touched.flatMap(row => ['happy', 'edge', 'adversarial'].flatMap(lane =>
      ((row.verificationIntent as Record<string, Array<{ id?: string; verification?: { command?: string; selector?: string } }>> | undefined)?.[lane] ?? [])
        .filter(entry => entry.verification?.command)
        .map(entry => `- ${entry.id ?? `${row.id}:${lane}`}: \`${entry.verification!.command}\`${entry.verification!.selector ? ` (test name: ${entry.verification!.selector})` : ''}`)));
    add('findings', 'Findings this repair is bound to (evidence as the reviewer recorded it) and the pinned commands of the items they touch',
      capBytes([...rows, ...(pins.length ? ['Pinned commands (gates replay them exactly; keep them passing):', ...pins] : [])].join('\n'), ITEM_PACK_LIMITS.findingsBytes, 'findings'));
  }

  const declared = [...new Set([...(item ? itemFiles(item) : []), ...cited.keys()])].slice(0, ITEM_PACK_LIMITS.maxFiles);
  if (base) {
    add('stat', `Story diff so far (${base.slice(0, 12)}...HEAD, material paths): stat`,
      capBytes(git(root, ['diff', '--stat=120', `${base}...HEAD`, ...material]).trimEnd() || '(no material change yet)', ITEM_PACK_LIMITS.statBytes, 'diff stat'));
    if (declared.length) {
      add('diff', `Story diff so far: hunks of the declared/cited files (${declared.join(', ')})`,
        capBytes(git(root, ['diff', '-U3', `${base}...HEAD`, '--', ...declared]).trimEnd() || '(these files are unchanged so far)', ITEM_PACK_LIMITS.diffBytes, 'diff hunks'));
    }
  }
  if (declared.length) {
    const files = declared.map(path => renderFile(root, path, cited.get(path) ?? [])).filter((row): row is string => Boolean(row));
    add('files', 'Declared/cited files at HEAD (line-numbered)', capBytes(files.join('\n'), ITEM_PACK_LIMITS.filesBytes, 'files'));
  }

  const subject = item ? `${item.id}` : findings.length ? `repair of ${findings.map(f => f.id.startsWith(`${args.storyId}:`) ? f.id.slice(args.storyId.length + 1) : f.id).join(', ')}` : 'this run';
  const body = out.join('\n\n');
  const header = [
    '',
    `--- BEGIN ITEM PACK (${args.arm ?? 'A/B implementation.thread=fresh, experimental'}; ${subject}) ---`,
    'This is a FRESH session: no earlier implementer or repair conversation is loaded. The framework built the pack below from the',
    'Story state at launch; start from it and read further only what it does not cover (sections are truncated where marked). The',
    'item, its intents, pinned selectors and test commands are the ones stated above; the completion steps and return contract above are unchanged.',
  ];
  const lines = [...header, body, '--- END ITEM PACK ---'];
  return { lines, bytes: Buffer.byteLength(lines.join('\n'), 'utf8'), sections };
}

