/**
 * EXPERIMENTAL A/B switches `review.lanePack` and `review.roundDelta`
 * (core/ab-variants.ts; bench-staging/oldpos/v41-cost-plan.md items A3, A4).
 *
 * Production (`off`, the default for both): every REVIEW lane and the
 * inventory critic gather the Story facts themselves. Old-PoS runs 22-26: the
 * 4 lanes each repeat the same `git diff`, story-file reads and git metadata
 * (~30% of lane commands), each starts at 22-24k context, and rounds 2-3 cost
 * as much as round 1 although only a few files change.
 *
 * `review.lanePack: "shared"`: the framework computes ONE lane pack per review
 * round and inlines it in every code-review lane prompt and the inventory
 * critic prompt (inside the sealed managed prompt, so `managedPromptDigest`
 * covers it), stating that it is authoritative for those facts:
 *   - the Story base, the candidate and its material commits (git metadata),
 *   - the changed material files with their sha256 at the candidate,
 *   - the candidate-spec route summary (the digests the read manifest binds,
 *     the candidate specs with content hashes) instead of the whole artifact,
 *   - the checklist intents with their pins and the recorded verification
 *     evidence (one line each),
 *   - the Story diff base...candidate with hunks (material paths).
 * request.md is already inline in the lane / critic dispatch prompt (D2/D3);
 * the pack names its hash and does not repeat it.
 *
 * `review.roundDelta: "pack"`: from the second candidate on (a later round),
 * the pack also carries the delta since the previous round's candidate: the
 * repair commits, the files they changed, the repair diff, and the findings
 * raised on earlier candidates with their resolutions. Lanes are told to start
 * from the delta but still review the whole Story (unlike the default fresh
 * later-round wording, which narrows the review to the findings and the repair
 * diff). With `review.lanePack` off the pack carries only the delta (and there
 * is no pack in round 1).
 *
 * Lanes keep full tool access and every read-evidence rule: no read budget, a
 * path counts as read fully only when the lane read the whole file. Detection
 * comes from the lanes' own probes; the pack only removes the repeated fact
 * gathering.
 *
 * Once per round: the pack is keyed by its inputs (Story, base, material hash
 * of the candidate, previous-round candidate, checklist, earlier findings,
 * route, request, flags) and written to
 * `<runtime>/.proof-or-stop/runtime/review-lane-packs/<storyId>/<head12>-<key16>.md`;
 * every later launch of the round reads that file instead of recomputing it.
 * Metadata-only commits between lane launches do not change the material
 * hash, so the lanes and the critic of one round share the file.
 *
 * The arm is decided at prompt build from the config; a malformed config keeps
 * production (no pack). The managed host run records the arm, the pack path,
 * digest and size in its immutable spec (`reviewBinding.lanePack`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abVariantEvidence, resolveAbVariants, type AbVariantEvidence } from './ab-variants.js';
import { loadConfig } from './config.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { earlierCandidateRuns, isCodeReviewLaneRun, isEarlierReviewRound, startedBefore } from './review-round-order.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import type { StoryStore } from './store.js';
import { readStoryRequest } from './story-request.js';
import type { ChecklistItem, Finding, ReviewRun } from './types.js';

export const LANE_PACK_SCHEMA = 'proof-or-stop.review-lane-pack.v1' as const;

export const LANE_PACK_LIMITS = {
  metaBytes: 3072,
  filesBytes: 4096,
  maxHashedFiles: 60,
  routeBytes: 3072,
  checklistBytes: 10240,
  diffBytes: 32768,
  deltaMetaBytes: 3072,
  deltaFindingsBytes: 6144,
  deltaDiffBytes: 24576,
  findingTextChars: 300,
  intentTextChars: 200,
} as const;

/** Upper bound of a pack: every section body at its cap plus the fixed framing (91,136 B, ~23k tokens). */
export const LANE_PACK_MAX_BYTES = LANE_PACK_LIMITS.metaBytes + LANE_PACK_LIMITS.filesBytes + LANE_PACK_LIMITS.routeBytes
  + LANE_PACK_LIMITS.checklistBytes + LANE_PACK_LIMITS.diffBytes + LANE_PACK_LIMITS.deltaMetaBytes
  + LANE_PACK_LIMITS.deltaFindingsBytes + LANE_PACK_LIMITS.deltaDiffBytes + 4096;

export type LanePackStore = Pick<StoryStore, 'readChecklist' | 'readFindings' | 'readReviewRuns' | 'readCandidateSpecSet' | 'storyDirRel' | 'storyFilePath' | 'readStory'>;

export interface LanePackVariants {
  lanePack: 'off' | 'shared';
  roundDelta: 'off' | 'pack';
  evidence: AbVariantEvidence | undefined;
}

export interface ReviewLanePack {
  lines: string[];
  /** UTF-8 bytes of `lines.join('\n')` (the exact inlined text). */
  bytes: number;
  /** Section title -> UTF-8 bytes of the section. */
  sections: Record<string, number>;
  /** The round's pack file (absolute). */
  path: string;
  /** sha256 of the pack text. */
  packDigest: string;
  abVariant: AbVariantEvidence;
  /** Present when the pack carries the round delta. */
  delta: { fromHead: string; toHead: string; diffComplete: boolean } | null;
  /** True when this launch reused the round's pack file. */
  cached: boolean;
}

/** Config arm; malformed config = production (both off). */
export function resolveLanePackVariants(root: string): LanePackVariants {
  try {
    const variants = resolveAbVariants(loadConfig(root));
    return { lanePack: variants.lanePack, roundDelta: variants.roundDelta, evidence: abVariantEvidence(variants) };
  } catch {
    return { lanePack: 'off', roundDelta: 'off', evidence: undefined };
  }
}

const GIT_OBJECT = /^[0-9a-f]{7,64}$/i;
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  } catch {
    return null;
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  } catch {
    return null;
  }
}

/** Keep whole lines up to `max` bytes; mark what was cut. */
function cap(text: string, max: number, what: string): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= max) return { text, truncated: false };
  const marker = `[lane pack: ${what} truncated at ${max} of ${total} bytes; fetch the rest yourself]`;
  const budget = max - Buffer.byteLength(marker, 'utf8') - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return { text: [...kept, marker].join('\n'), truncated: true };
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[^/]+$|_test\.[^/]+$/i;

/**
 * A bounded diff: whole per-file diffs, source files before tests, each kept
 * whole while it fits; a file that does not fit is listed by name (the lane
 * reads it itself), except that a source file is cut by lines when nothing of
 * it would otherwise show.
 */
function boundedDiff(diff: string, max: number, what: string): { text: string; complete: boolean } {
  const files = diff.split(/(?=^diff --git )/m).filter(part => part.trim());
  const pathOf = (part: string) => /^diff --git a\/(.+?) b\//.exec(part)?.[1] ?? '?';
  const ordered = [...files.filter(part => !TEST_PATH.test(pathOf(part))), ...files.filter(part => TEST_PATH.test(pathOf(part)))];
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const reserve = 512;
  for (const part of ordered) {
    const body = part.replace(/\n$/, '');
    const size = Buffer.byteLength(body, 'utf8') + 1;
    if (used + size <= max - reserve) {
      kept.push(body);
      used += size;
    } else if (!TEST_PATH.test(pathOf(part)) && max - reserve - used > 4096) {
      const cut = cap(body, max - reserve - used, `${what} of ${pathOf(part)}`);
      kept.push(cut.text);
      used += Buffer.byteLength(cut.text, 'utf8') + 1;
    } else {
      omitted.push(pathOf(part));
    }
  }
  const complete = omitted.length === 0 && kept.every(part => !part.includes('[lane pack: '));
  return {
    text: [...kept, ...(omitted.length ? [`[lane pack: ${what} hunks not included for ${omitted.length} file(s), read them yourself: ${oneLine(omitted.join(', '), 400)}]`] : [])].join('\n'),
    complete,
  };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function shortId(storyId: string, id: string): string {
  return id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;
}

/** Story base: the frozen integration base when recorded, else the merge-base with main/master. */
function storyBase(store: LanePackStore, gitCwd: string, storyId: string, head: string): string | null {
  try {
    const target = (store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: unknown } }).integrationTarget;
    const frozen = target?.parentCommitAtCreation;
    if (typeof frozen === 'string' && GIT_OBJECT.test(frozen) && gitText(gitCwd, ['cat-file', '-e', `${frozen}^{commit}`]) !== null) return frozen;
  } catch { /* no story metadata: fall back */ }
  for (const branch of ['main', 'master']) {
    const base = gitText(gitCwd, ['merge-base', head, branch])?.trim();
    if (base && GIT_OBJECT.test(base)) return base;
  }
  return null;
}

function materialPaths(gitCwd: string, root: string, from: string, to: string): Array<{ status: string; path: string }> | null {
  const out = gitText(gitCwd, ['diff', '--no-renames', '--name-status', '-z', from, to, '--']);
  if (out === null) return null;
  const parts = out.split('\0').filter(Boolean);
  const rows: Array<{ status: string; path: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const path = parts[index + 1]!;
    if (!isMaterialExcludedPath(path, root)) rows.push({ status: parts[index]!.slice(0, 1), path });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** Previous round: the newest earlier-candidate code-review run whose material differs from this run's. */
function previousRoundRun(runs: readonly ReviewRun[], run: ReviewRun): ReviewRun | null {
  const earlier = earlierCandidateRuns(runs, run)
    .filter(row => isCodeReviewLaneRun(row) && row.materialHash !== run.materialHash && GIT_OBJECT.test(row.headHash));
  let newest: ReviewRun | null = null;
  for (const row of earlier) if (!newest || startedBefore(newest, row)) newest = row;
  return newest;
}

function earlierFindings(store: LanePackStore, runs: readonly ReviewRun[], run: ReviewRun): Finding[] {
  const earlierIds = new Set(earlierCandidateRuns(runs, run).map(row => row.reviewRunId));
  let findings: Finding[] = [];
  try { findings = store.readFindings(run.storyId).findings; } catch { return []; }
  return findings
    .filter(finding => finding.reviewRunId
      ? earlierIds.has(finding.reviewRunId)
      : typeof finding.reviewRound === 'string' && isEarlierReviewRound(finding.reviewRound, run.reviewRound))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function renderChecklist(items: readonly ChecklistItem[]): string {
  const rows: string[] = [];
  for (const item of items) {
    const files = item.files ? [...new Set([...item.files.modify, ...item.files.create, ...item.files.test])] : [];
    rows.push(`- ${item.id} [${item.status}] ${oneLine(item.title ?? '', LANE_PACK_LIMITS.intentTextChars)}${files.length ? ` — files: ${files.join(', ')}` : ''}`);
    const evidence = item.verificationEvidence ?? [];
    const intent = (item.verificationIntent ?? {}) as unknown as Record<string, unknown>;
    for (const [lane, entries] of Object.entries(intent)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((raw, index) => {
        const entry = raw as { id?: string; desc?: string; type?: string; verification?: { command?: string; selector?: string } };
        const ref = entry.id ?? `${item.id}:${lane}:${index}`;
        const pin = entry.verification?.command ? ` — pin: \`${entry.verification.command}\`${entry.verification.selector ? ` (${entry.verification.selector})` : ''}` : '';
        const last = [...evidence].reverse().find(row => row.intentRef === ref);
        const proof = last
          ? `${last.kind}${last.result ? ` ${last.result}` : ''}${last.mechanical === true ? ' mechanical' : last.mechanical === false ? ' attested' : ''} @${last.headHash ? last.headHash.slice(0, 7) : '?'}`
          : 'none';
        rows.push(`  ${ref} [${entry.type ?? 'n/a'}] ${oneLine(entry.desc ?? '', LANE_PACK_LIMITS.intentTextChars)}${pin} — evidence: ${proof}`);
      });
    }
  }
  return rows.join('\n');
}

function renderRoute(store: LanePackStore, storyId: string): string {
  let artifact: ReturnType<LanePackStore['readCandidateSpecSet']> = null;
  try { artifact = store.readCandidateSpecSet(storyId); } catch { artifact = null; }
  if (!artifact) return 'No candidate-spec-set.json yet: read it yourself when you need the route.';
  const byPath = new Map((artifact.candidates ?? []).map(row => [row.path, row]));
  return [
    `candidateSpecSetDigest=${artifact.artifactDigest} corpusDigest=${artifact.corpusDigest} mode=${artifact.mode} fullScan=${artifact.fullScan}${artifact.scanEscalationReason ? ` scanEscalationReason=${JSON.stringify(artifact.scanEscalationReason)}` : ''}${artifact.requiresEscalation ? ` requiresEscalation (${artifact.escalationReasons.join(', ')})` : ''}`,
    'Copy readManifest.candidateSpecSetDigest and readManifest.corpusDigest from this line (they are the values of candidate-spec-set.json).',
    `Candidate specs (${artifact.candidateSpecSet.length}; each still needs your full read):`,
    ...(artifact.candidateSpecSet.length === 0 ? ['- none'] : artifact.candidateSpecSet.map(path => {
      const row = byPath.get(path);
      return `- ${path}${row ? ` ${row.contentHash} score=${row.score}` : ''}`;
    })),
  ].join('\n');
}

interface Inputs {
  store: LanePackStore;
  root: string;
  gitCwd: string;
  run: ReviewRun;
  variants: LanePackVariants;
  base: string | null;
  previous: ReviewRun | null;
  items: ChecklistItem[];
  findings: Finding[];
  requestLine: string;
}

function buildPackText(input: Inputs): { lines: string[]; sections: Record<string, number>; delta: ReviewLanePack['delta'] } {
  const { run, variants, base, previous, gitCwd, root } = input;
  const head = run.headHash;
  const storyDir = input.store.storyDirRel().replace(/\/+$/, '');
  const material = ['--', '.', `:(exclude)${storyDir}`, `:(exclude)${PROOF_OR_STOP_DIR}`];
  const sections: Record<string, number> = {};
  const out: string[] = [];
  const add = (_name: string, title: string, body: string) => {
    const block = `## ${title}\n${body}`;
    sections[title] = Buffer.byteLength(block, 'utf8');
    out.push(block);
  };
  const shared = variants.lanePack === 'shared';
  if (shared) {
    const commits = base ? (gitText(gitCwd, ['log', '--format=commit %h %s', `${base}..${head}`, ...material]) ?? '').trimEnd() : '';
    add('meta', 'Story candidate and git metadata', cap([
      `Story ${run.storyId}; base ${base ?? '(unresolved: run git merge-base yourself)'}; candidate ${head} (material hash ${run.materialHash}).`,
      input.requestLine,
      `Material commits base..candidate (Story metadata commits excluded):`,
      commits || '(none)',
    ].join('\n'), LANE_PACK_LIMITS.metaBytes, 'git metadata').text);
    const changed = base ? materialPaths(gitCwd, root, base, head) : null;
    const fileRows = (changed ?? []).map((row, index) => {
      if (row.status === 'D' || index >= LANE_PACK_LIMITS.maxHashedFiles) return `- ${row.path} [${row.status}]`;
      const blob = gitBuffer(gitCwd, ['show', `${head}:${row.path}`]);
      return blob ? `- ${row.path} [${row.status}] sha256=${sha256(blob)} lines=${blob.toString('utf8').split('\n').length - (blob.length && blob[blob.length - 1] === 10 ? 1 : 0)}` : `- ${row.path} [${row.status}]`;
    });
    add('files', `Changed material files base...candidate (${changed?.length ?? 0}; sha256 of the file at the candidate)`,
      cap(changed === null ? '(unavailable: run git diff --name-status yourself)' : fileRows.join('\n') || '(no material change)', LANE_PACK_LIMITS.filesBytes, 'changed files').text);
    add('route', 'Candidate spec route (summary of candidate-spec-set.json)', cap(renderRoute(input.store, run.storyId), LANE_PACK_LIMITS.routeBytes, 'route').text);
    add('checklist', 'Checklist intents and verification evidence (pins as recorded; latest evidence per intent)',
      cap(renderChecklist(input.items) || '(no checklist items)', LANE_PACK_LIMITS.checklistBytes, 'checklist').text);
    const paths = (changed ?? []).map(row => row.path);
    const diff = base && paths.length ? gitText(gitCwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', `${base}...${head}`, '--', ...paths]) : '';
    add('diff', `Story diff ${base ? base.slice(0, 12) : '?'}...${head.slice(0, 12)} (material paths, hunks; source files first)`,
      diff === null ? '(unavailable: run git diff yourself)' : !diff.trim() ? '(no material change)' : boundedDiff(diff, LANE_PACK_LIMITS.diffBytes, 'Story diff').text);
  }
  let delta: ReviewLanePack['delta'] = null;
  if (variants.roundDelta === 'pack' && previous) {
    const from = previous.headHash;
    const commits = (gitText(gitCwd, ['log', '--format=commit %h %s', `${from}..${head}`, ...material]) ?? '').trimEnd();
    const changed = materialPaths(gitCwd, root, from, head) ?? [];
    add('deltaMeta', `Delta since the previous round (candidate ${from.slice(0, 12)} -> ${head.slice(0, 12)})`, cap([
      'Start from this delta: re-verify each earlier finding against the new code and review the repair diff and the callers of the code it changed first. Then review the whole Story as your role requires: code outside the repair diff is not exempt, and earlier rounds can have missed defects there.',
      `Repair commits (Story metadata commits excluded):`,
      commits || '(none)',
      `Files changed since the previous round (${changed.length}):`,
      ...(changed.length ? changed.map(row => `- ${row.path} [${row.status}]`) : ['- none (only Story metadata changed)']),
    ].join('\n'), LANE_PACK_LIMITS.deltaMetaBytes, 'delta metadata').text);
    const findingRows = input.findings.flatMap(finding => [
      `- ${shortId(run.storyId, finding.id)} [severity=${finding.severity}, status=${finding.status}${finding.agent ? `, lane=${finding.agent}` : ''}] ${oneLine(finding.desc ?? '', LANE_PACK_LIMITS.findingTextChars)}`,
      `  resolution: ${finding.resolvedReason ? oneLine(finding.resolvedReason, LANE_PACK_LIMITS.findingTextChars) : `none recorded (status ${finding.status})`}${finding.resolvedBy ? ` (${finding.resolvedBy})` : ''}`,
    ]);
    add('deltaFindings', `Findings raised on earlier candidates and their resolutions (${input.findings.length})`,
      cap(findingRows.join('\n') || '- none', LANE_PACK_LIMITS.deltaFindingsBytes, 'earlier findings').text);
    const diff = changed.length ? gitText(gitCwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', from, head, '--', ...changed.map(row => row.path)]) : '';
    const capped = diff === null ? { text: `(unavailable: run git diff ${from} ${head} yourself)`, complete: false }
      : !diff.trim() ? { text: '(no material change)', complete: true } : boundedDiff(diff, LANE_PACK_LIMITS.deltaDiffBytes, 'repair diff');
    add('deltaDiff', `Repair diff ${from.slice(0, 12)}..${head.slice(0, 12)} (material paths; source files first)`, capped.text);
    delta = { fromHead: from, toHead: head, diffComplete: capped.complete };
  }
  const arm = [shared ? 'review.lanePack=shared' : null, delta ? 'review.roundDelta=pack' : null].filter(Boolean).join(' + ');
  const header = [
    `--- BEGIN REVIEW LANE PACK (A/B ${arm}, experimental; ${run.storyId} candidate ${head.slice(0, 12)}) ---`,
    `The framework computed this pack ONCE for this review round from the canonical repository and inlines the same text in every review lane and critic prompt of the round (valid for every candidate with material hash ${run.materialHash}).`,
    shared
      ? 'It is authoritative for the facts it states: the Story base, candidate and material commits, the changed files and their sha256, the Story diff, the checklist intents with their pins and recorded evidence, and the candidate-spec route digests. Do not re-run `git diff`, `git log`, `git rev-parse` or `sha256sum`, and do not re-read checklist.json or candidate-spec-set.json, to obtain them.'
      : 'It is authoritative for the delta facts it states (repair commits, changed files, repair diff, earlier findings and their resolutions); do not re-run git to obtain them.',
    'The pack reviews nothing for you: keep probing the code (read the changed files and their callers, run focused tests and probes) exactly as your role requires; detection comes from your own probes. Read-evidence rules are unchanged: list a path in filesReadFully only when you read the whole file yourself (hunks shown here are not full reads). A section marked truncated is incomplete: fetch the rest yourself.',
  ];
  return { lines: [...header, '', out.join('\n\n'), '--- END REVIEW LANE PACK ---'], sections, delta };
}

/**
 * The round's lane pack for a managed code-review lane or inventory critic run,
 * or null (production) when both switches are off (or malformed), the run is
 * neither, or `review.roundDelta` alone has no earlier round to carry.
 */
export function resolveReviewLanePack(root: string, run: ReviewRun, opts: { store?: LanePackStore; gitCwd?: string } = {}): ReviewLanePack | null {
  const variants = resolveLanePackVariants(root);
  if (variants.lanePack === 'off' && variants.roundDelta === 'off') return null;
  if (!variants.evidence) return null;
  if (!isCodeReviewLaneRun(run) && run.reviewPurpose !== 'inventory-completeness') return null;
  if (!GIT_OBJECT.test(run.headHash ?? '')) return null;
  const store = opts.store;
  if (!store) throw new Error('resolveReviewLanePack: a story store is required');
  const gitCwd = opts.gitCwd ?? run.workspaceBinding?.signedWorkspaceRoot ?? root;
  let runs: ReviewRun[] = [];
  try { runs = store.readReviewRuns(run.storyId).runs; } catch { runs = []; }
  const previous = variants.roundDelta === 'pack' ? previousRoundRun(runs, run) : null;
  if (variants.lanePack === 'off' && !previous) return null;
  let items: ChecklistItem[] = [];
  try { items = store.readChecklist(run.storyId).items; } catch { items = []; }
  const findings = previous ? earlierFindings(store, runs, run) : [];
  const request = readStoryRequest(store, run.storyId);
  const requestRel = `${store.storyDirRel()}/${run.storyId}/request.md`;
  const requestLine = request.status === 'ok'
    ? `request.md (${requestRel}, sha256=${request.meta.sha256.slice(0, 12)}) is inline above as the verbatim user request; it is not repeated here.`
    : request.status === 'tampered' ? `request.md: ${request.reason}` : 'request.md: none recorded for this Story.';
  const base = storyBase(store, gitCwd, run.storyId, run.headHash);
  let routeDigest: string | null = null;
  try { routeDigest = store.readCandidateSpecSet(run.storyId)?.artifactDigest ?? null; } catch { routeDigest = null; }
  const key = sha256(JSON.stringify({
    schema: LANE_PACK_SCHEMA, storyId: run.storyId, base, material: run.materialHash || run.headHash,
    previous: previous?.headHash ?? null, flags: variants.evidence.flags, checklist: sha256(JSON.stringify(items)),
    findings: sha256(JSON.stringify(findings)), route: routeDigest, request: requestLine,
  }));
  const dir = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'review-lane-packs', run.storyId.replace(/[^A-Za-z0-9._-]/g, '_'));
  const existing = existsSync(dir) ? (() => {
    try { return readdirSync(dir).find(name => name.endsWith(`-${key.slice(0, 16)}.md`)) ?? null; } catch { return null; }
  })() : null;
  // Section sizes of a cached pack, by section title.
  const sectionsOf = (text: string) => Object.fromEntries(text.split(/\n(?=## )/).slice(1).map(block => [block.slice(3, block.indexOf('\n') < 0 ? undefined : block.indexOf('\n')), Buffer.byteLength(block, 'utf8')]));
  if (existing) {
    const path = join(dir, existing);
    const text = readFileSync(path, 'utf8');
    const delta = previous ? { fromHead: previous.headHash, toHead: run.headHash, diffComplete: !/\[lane pack: repair diff /.test(text) } : null;
    return {
      lines: text.split('\n'), bytes: Buffer.byteLength(text, 'utf8'), sections: sectionsOf(text), path, packDigest: `sha256:${sha256(text)}`,
      abVariant: variants.evidence, delta, cached: true,
    };
  }
  const built = buildPackText({ store, root, gitCwd, run, variants, base, previous, items, findings, requestLine });
  const text = built.lines.join('\n');
  const path = join(dir, `${run.headHash.slice(0, 12)}-${key.slice(0, 16)}.md`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the prompt still carries the pack; the file is the round cache and audit copy */ }
  return {
    lines: built.lines, bytes: Buffer.byteLength(text, 'utf8'), sections: built.sections, path, packDigest: `sha256:${sha256(text)}`,
    abVariant: variants.evidence, delta: built.delta, cached: false,
  };
}
