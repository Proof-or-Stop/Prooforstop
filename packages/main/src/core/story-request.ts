/**
 * Verbatim user request artifact (request.md + request.json) — benchmark run 13.
 *
 * background.md / index.json hold only the Story owner's paraphrase. When the
 * paraphrase drops an example or one variant of an enumerated set, no PLAN
 * reviewer has an authoritative text to trace against. request.md stores the
 * user's request verbatim (bounded), request.json binds its sha256 so a hand
 * edit is detected, and every replacement after the first record is an
 * explicit, reasoned amendment kept in request.json.
 *
 * Consumers: the PLAN scope-plan reviewer prompt (inline, with the mechanical
 * literal pre-check), every REVIEW lane and the inventory critic (inline, with
 * the request-outranks-intent rubric; core/request-authority.ts, old-PoS run 23
 * reversed the earlier "REVIEW lanes never get it"), the PLAN
 * verification-intent author, the INIT product reviewer, the DEV implementer
 * and the finding-repair worker (path only).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoryStore } from './store.js';

export const STORY_REQUEST_MAX_BYTES = 16 * 1024;
export const STORY_REQUEST_FILE = 'request.md';
export const STORY_REQUEST_META_FILE = 'request.json';
export const STORY_REQUEST_AMENDMENT_MIN_CHARS = 30;
/** Phases in which the request may be recorded or amended. */
export const STORY_REQUEST_WRITABLE_PHASES: readonly string[] = ['IDEA', 'INIT', 'INIT_CHECK', 'PLAN'];
const STAGED_REQUEST_REL = ['.proof-or-stop', 'runtime', 'staged-story-request.md'] as const;

export interface StoryRequestAmendment {
  at: string;
  phase: string;
  reason: string;
  previousSha256: string;
}

export interface StoryRequestMeta {
  schemaVersion: 1;
  sha256: string;
  bytes: number;
  originalBytes: number;
  truncated: boolean;
  source: string;
  recordedAt: string;
  amendments: StoryRequestAmendment[];
}

export type StoryRequestRead =
  | { status: 'absent' }
  | { status: 'ok'; text: string; meta: StoryRequestMeta; path: string }
  | { status: 'tampered'; path: string; reason: string };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Bound to STORY_REQUEST_MAX_BYTES on a UTF-8 boundary with an explicit truncation marker. */
export function boundStoryRequest(raw: string): { text: string; originalBytes: number; truncated: boolean } {
  const normalized = raw.endsWith('\n') ? raw : `${raw}\n`;
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  if (Buffer.byteLength(normalized, 'utf8') <= STORY_REQUEST_MAX_BYTES) return { text: normalized, originalBytes, truncated: false };
  const marker = (kept: number) => `\n[proof-or-stop: request truncated at ${kept} of ${originalBytes} bytes; the remainder was not recorded]\n`;
  let keep = STORY_REQUEST_MAX_BYTES - Buffer.byteLength(marker(STORY_REQUEST_MAX_BYTES), 'utf8');
  const bytes = Buffer.from(normalized, 'utf8');
  // Step back over UTF-8 continuation bytes so no code point is split.
  while (keep > 0 && (bytes[keep] & 0xc0) === 0x80) keep -= 1;
  const head = bytes.subarray(0, keep).toString('utf8');
  return { text: `${head}${marker(keep)}`, originalBytes, truncated: true };
}

export function readStoryRequest(store: StoryStore, storyId: string): StoryRequestRead {
  const path = store.storyFilePath(storyId, STORY_REQUEST_FILE);
  const metaPath = store.storyFilePath(storyId, STORY_REQUEST_META_FILE);
  if (!existsSync(path) && !existsSync(metaPath)) return { status: 'absent' };
  if (!existsSync(path) || !existsSync(metaPath)) {
    return { status: 'tampered', path, reason: `${STORY_REQUEST_FILE} and ${STORY_REQUEST_META_FILE} must exist together` };
  }
  let meta: StoryRequestMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as StoryRequestMeta;
  } catch {
    return { status: 'tampered', path, reason: `${STORY_REQUEST_META_FILE} is not valid JSON` };
  }
  const text = readFileSync(path, 'utf8');
  if (typeof meta?.sha256 !== 'string' || sha256(text) !== meta.sha256) {
    return { status: 'tampered', path, reason: `${STORY_REQUEST_FILE} does not match ${STORY_REQUEST_META_FILE} sha256 (edited outside story_request_set)` };
  }
  return { status: 'ok', text, meta, path };
}

/**
 * Records (or amends) the verbatim request. The first record in IDEA/INIT needs no
 * reason; any replacement, and any first record after INIT, requires an
 * amendmentReason that is kept in request.json.
 */
export function writeStoryRequest(store: StoryStore, args: {
  storyId: string;
  phase: string;
  request: string;
  source: string;
  amendmentReason?: string;
  now?: string;
}): { meta: StoryRequestMeta; amended: boolean } {
  if (!STORY_REQUEST_WRITABLE_PHASES.includes(args.phase)) {
    throw new Error(
      `story_request_set refused: the verbatim request is frozen in ${args.phase}; it may be recorded or amended only in ${STORY_REQUEST_WRITABLE_PHASES.join('/')}. [story_request_frozen]`,
    );
  }
  if (typeof args.request !== 'string' || args.request.trim().length === 0) {
    throw new Error('story_request_set requires a non-empty request (or requestFile). [story_request_empty]');
  }
  const previous = readStoryRequest(store, args.storyId);
  const needsReason = previous.status !== 'absent' || (args.phase !== 'IDEA' && args.phase !== 'INIT');
  const reason = args.amendmentReason?.trim() ?? '';
  if (needsReason && reason.length < STORY_REQUEST_AMENDMENT_MIN_CHARS) {
    throw new Error(
      `story_request_set refused: ${previous.status === 'absent' ? `recording the request after INIT (${args.phase})` : 'replacing the recorded request'} is an amendment; ` +
      `pass amendmentReason (at least ${STORY_REQUEST_AMENDMENT_MIN_CHARS} characters) stating what the user changed or clarified. [story_request_amendment_reason_required]`,
    );
  }
  const now = args.now ?? new Date().toISOString();
  const bounded = boundStoryRequest(args.request);
  const priorAmendments = previous.status === 'ok' ? previous.meta.amendments ?? [] : [];
  const previousSha256 = previous.status === 'ok'
    ? previous.meta.sha256
    : previous.status === 'tampered' ? 'tampered' : 'absent';
  const meta: StoryRequestMeta = {
    schemaVersion: 1,
    sha256: sha256(bounded.text),
    bytes: Buffer.byteLength(bounded.text, 'utf8'),
    originalBytes: bounded.originalBytes,
    truncated: bounded.truncated,
    source: args.source,
    recordedAt: now,
    amendments: needsReason
      ? [...priorAmendments, { at: now, phase: args.phase, reason, previousSha256 }]
      : priorAmendments,
  };
  const dir = store.storyDirPath(args.storyId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(store.storyFilePath(args.storyId, STORY_REQUEST_FILE), bounded.text, 'utf8');
  writeFileSync(store.storyFilePath(args.storyId, STORY_REQUEST_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { meta, amended: needsReason };
}

export function stagedStoryRequestPath(mainRoot: string): string {
  return join(mainRoot, ...STAGED_REQUEST_REL);
}

/** Stage a request for the next story_create in this checkout (benchmark adapters, wrappers). */
export function stageStoryRequest(mainRoot: string, request: string): { path: string; bytes: number; truncated: boolean } {
  if (typeof request !== 'string' || request.trim().length === 0) {
    throw new Error('story_request_set requires a non-empty request (or requestFile). [story_request_empty]');
  }
  const bounded = boundStoryRequest(request);
  const path = stagedStoryRequestPath(mainRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, request, 'utf8');
  return { path, bytes: Buffer.byteLength(bounded.text, 'utf8'), truncated: bounded.truncated };
}

/** Read-and-remove the staged request (consumed exactly once by story_create). */
export function consumeStagedStoryRequest(mainRoot: string): string | null {
  const path = stagedStoryRequestPath(mainRoot);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  rmSync(path, { force: true });
  return text.trim().length > 0 ? text : null;
}

/** Backticked literals of the request (examples, enumerated variants, exact messages), in order, deduplicated. */
export function storyRequestLiterals(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Fenced blocks are code samples, not single literals; skip them.
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const literal = match[1].trim();
    // A bare word of at most 3 characters (`0`, `end`, `i`) names a component, not a checkable variant.
    if (literal.length === 0 || seen.has(literal) || /^\w{1,3}$/.test(literal)) continue;
    seen.add(literal);
    out.push(literal);
  }
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the literal (whitespace-insensitive; `<placeholder>` matches anything) appears in the haystack. */
export function literalStated(literal: string, squashedHaystack: string): boolean {
  const target = squash(literal);
  if (squashedHaystack.includes(target)) return true;
  if (!/<[^<>]+>/.test(target)) return false;
  const fragments = target.split(/<[^<>]+>/).filter(Boolean);
  if (fragments.length === 0) return true;
  return new RegExp(fragments.map(escapeRegExp).join('[\\s\\S]*?')).test(squashedHaystack);
}

/**
 * Mechanical pre-check: request literals that no checklist title, userSees or
 * verificationIntent states. Each one is a traceability gap candidate the
 * scope-plan reviewer must classify (covered by an exact intent, excluded, or gap).
 */
export function unmappedStoryRequestLiterals(
  requestText: string,
  items: ReadonlyArray<{ title?: string; userSees?: string; verificationIntent?: unknown; excludes?: readonly string[] }>,
  options: { countExcludes?: boolean } = {},
): string[] {
  // countExcludes (next's PLAN pre-scope check): a PLAN excludes entry that names
  // the literal is the reviewer's "excluded (cite the excluding text)" input, so
  // the owner has handled it. The scope-plan prompt pre-check keeps the default.
  const haystack = squash(items.map(item => [
    item.title ?? '',
    item.userSees ?? '',
    item.verificationIntent === undefined ? '' : JSON.stringify(item.verificationIntent),
    options.countExcludes ? (item.excludes ?? []).join('\n') : '',
  ].join('\n')).join('\n'));
  // JSON.stringify escapes quotes and backslashes; compare against both forms.
  const unescaped = haystack.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return storyRequestLiterals(requestText).filter(literal => !literalStated(literal, haystack) && !literalStated(literal, unescaped));
}

/**
 * Run 19 (§5): the actionable intake form of the literal warning. userSees is
 * editable in INIT and PLAN (frozen from DEV; handlers/checklist.ts), so the
 * owner records each literal on the item that delivers it with one exact
 * checklist_update per item, now or in PLAN. No new Story is needed. Whatever
 * is still unstated at PLAN, `next` returns as its pre-scope authoring step.
 */
export function renderUnmappedLiteralsRemedy(
  storyId: string,
  unmapped: readonly string[],
  items: ReadonlyArray<{ id: string; userSees?: string }>,
  limit = 12,
): string {
  const shown = items.slice(0, limit).map(item => `    proof-or-stop checklist_update '${JSON.stringify({ storyId, itemId: item.id,
    userSees: `<the userSees of ${item.id}${item.userSees?.trim() ? ' as it is now' : ''}, plus each literal above that ${item.id} delivers, quoted exactly>` }).replace(/'/g, "'\\''")}'`);
  const more = items.length > limit ? `\n    (+${items.length - limit} more items: same command with their itemId)` : '';
  return `⚠ ${renderUnmappedLiteralsLine(unmapped)}.\n`
    + '  Each example and each listed variant needs a checklist userSees or PLAN verificationIntent that states it exactly, or a PLAN excludes entry that names it with a reason. '
    + 'userSees is editable in INIT and PLAN (frozen from DEV), so record them on this Story now, item by item (skip items that deliver none):\n'
    + `${shown.join('\n')}${more}\n`
    + `  In PLAN, \`proof-or-stop next --storyId=${storyId}\` lists any literal still unstated before it launches the scope-plan reviewer.`;
}

/** One bounded line for prompts and story_create output. */
export function renderUnmappedLiteralsLine(unmapped: readonly string[], limit = 40): string {
  const shown = unmapped.slice(0, limit).map(literal => `\`${literal}\``).join(', ');
  const more = unmapped.length > limit ? ` (+${unmapped.length - limit} more)` : '';
  return `Request literals no checklist item states (title/userSees/verificationIntent): ${shown}${more}`;
}
