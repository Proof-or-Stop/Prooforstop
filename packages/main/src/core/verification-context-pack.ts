import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  digestCanonical,
  digestVerificationContextPack,
  parseVerificationContextPackContract,
  type ContextPackHunkContract,
  type ContextPackSnippetContract,
  type ContextPackSymbolContract,
  type VerificationContextPackContract,
} from './authority-contracts.js';

export interface VerificationContextPackInput {
  root: string;
  producerRunId: string;
  storyId?: string;
  baseRef?: string;
  headRef?: string;
  packId?: string;
  checklistItemIds?: string[];
  testIntentRefs?: string[];
  acceptanceCriteria?: string[];
  requiredRefs?: string[];
  requiredCommands?: VerificationContextPackContract['requiredCommands'];
  oracleRefs?: string[];
  tokenBudget?: number;
  excludedPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface VerificationContextPackResult {
  pack: VerificationContextPackContract;
  packDigest: string;
  diffText: string;
}

export interface VerificationContextPackExpansionInput {
  packId?: string;
  expansionReason: string;
  impactedFiles?: string[];
  impactedSymbols?: ContextPackSymbolContract[];
  dependencyEdges?: VerificationContextPackContract['dependencyEdges'];
  sourceSnippets?: ContextPackSnippetContract[];
  requiredRefs?: string[];
  tokenBudget?: number;
  metadata?: Record<string, unknown>;
}

const TOKEN_BUDGET_LIMITATION = 'token budget truncated source snippets';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countTokensApprox(text: string): number {
  return Math.ceil(text.length / 4);
}

function diffArgs(baseRef?: string, headRef?: string): string[] {
  const base = baseRef || 'HEAD';
  if (!headRef || headRef === 'WORKTREE') return ['diff', '--no-ext-diff', '--unified=3', base];
  return ['diff', '--no-ext-diff', '--unified=3', `${base}..${headRef}`];
}

function nameOnlyArgs(baseRef?: string, headRef?: string): string[] {
  const base = baseRef || 'HEAD';
  if (!headRef || headRef === 'WORKTREE') return ['diff', '--name-only', base];
  return ['diff', '--name-only', `${base}..${headRef}`];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function listChangedFiles(root: string, baseRef?: string, headRef?: string): string[] {
  return git(root, nameOnlyArgs(baseRef, headRef)).split('\n').filter(Boolean);
}

function listUntrackedFiles(root: string, headRef?: string): string[] {
  if (headRef && headRef !== 'WORKTREE') return [];
  return git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
}

function syntheticDiffForUntrackedFile(root: string, file: string): string {
  const full = join(root, file);
  if (!existsSync(full)) return '';
  const content = readFileSync(full, 'utf8');
  const lines = content.length === 0
    ? []
    : content.endsWith('\n')
      ? content.slice(0, -1).split('\n')
      : content.split('\n');
  if (lines.length === 0) {
    return [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      `index 0000000..${sha256(content).slice(0, 7)}`,
      '--- /dev/null',
      `+++ b/${file}`,
    ].join('\n');
  }
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    `index 0000000..${sha256(content).slice(0, 7)}`,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n');
}

function appendUntrackedDiffs(root: string, diffText: string, untrackedFiles: string[]): string {
  const untrackedDiffs = untrackedFiles
    .map(file => syntheticDiffForUntrackedFile(root, file))
    .filter(Boolean);
  return [diffText, ...untrackedDiffs].filter(Boolean).join('\n');
}

export function parseGitDiffHunks(diffText: string): ContextPackHunkContract[] {
  const hunks: ContextPackHunkContract[] = [];
  let currentOldFile = '';
  let currentNewFile = '';
  let patchLines: string[] = [];
  let current: Omit<ContextPackHunkContract, 'patchHash'> | undefined;

  function flush() {
    if (!current) return;
    hunks.push({
      ...current,
      patchHash: sha256(patchLines.join('\n')),
    });
    patchLines = [];
  }

  for (const line of diffText.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffMatch) {
      flush();
      currentOldFile = diffMatch[1];
      currentNewFile = diffMatch[2];
      continue;
    }
    const oldFileMatch = line.match(/^--- a\/(.+)$/);
    if (oldFileMatch) {
      currentOldFile = oldFileMatch[1];
      continue;
    }
    if (line === '--- /dev/null') {
      currentOldFile = '';
      continue;
    }
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      currentNewFile = newFileMatch[1];
      continue;
    }
    if (line === '+++ /dev/null') {
      currentNewFile = '';
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      flush();
      const oldStart = Number(hunkMatch[1]);
      const oldLines = Number(hunkMatch[2] ?? '1');
      const newStart = Number(hunkMatch[3]);
      const newLines = Number(hunkMatch[4] ?? '1');
      const file = currentNewFile || currentOldFile;
      if (!file) {
        current = undefined;
        patchLines = [];
        continue;
      }
      const hunkAnchor = newStart > 0 ? newStart : oldStart;
      const header = line;
      current = {
        hunkRef: `${file}:${hunkAnchor}`,
        file,
        oldStart,
        oldLines,
        newStart,
        newLines,
        header,
        riskTags: riskTagsForFile(file),
        required: true,
        metadata: {},
      };
      patchLines = [line];
      continue;
    }
    if (current) patchLines.push(line);
  }
  flush();
  return hunks;
}

function riskTagsForFile(file: string): string[] {
  const tags = new Set<string>();
  if (/auth|security|signature|evidence|authority|gate|policy/i.test(file)) tags.add('security');
  if (/test|spec|smoke/i.test(file)) tags.add('test');
  if (/package\.json|config|cli-engine|registry/i.test(file)) tags.add('tooling');
  return [...tags].sort();
}

function snippetsForHunks(root: string, hunks: ContextPackHunkContract[], tokenBudget?: number): {
  snippets: ContextPackSnippetContract[];
  estimatedTokens: number;
  truncated: boolean;
} {
  const snippets: ContextPackSnippetContract[] = [];
  let estimatedTokens = 0;
  let truncated = false;

  for (const hunk of hunks) {
    const full = join(root, hunk.file);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    const startLine = Math.max(1, (hunk.newStart ?? 1) - 3);
    const endLine = Math.min(lines.length, (hunk.newStart ?? 1) + (hunk.newLines ?? 1) + 3);
    const content = lines.slice(startLine - 1, endLine).join('\n');
    const tokenEstimate = countTokensApprox(content);
    if (tokenBudget !== undefined && estimatedTokens + tokenEstimate > tokenBudget) {
      truncated = true;
      continue;
    }
    estimatedTokens += tokenEstimate;
    snippets.push({
      snippetRef: `${hunk.file}:${startLine}-${endLine}`,
      file: hunk.file,
      startLine,
      endLine,
      contentHash: sha256(content),
      content,
      hunkRefs: [hunk.hunkRef],
      tokenEstimate,
      reason: 'changed hunk context',
      metadata: {},
    });
  }

  return { snippets, estimatedTokens, truncated };
}

function estimateSnippetTokens(snippet: ContextPackSnippetContract): number {
  if (snippet.tokenEstimate !== undefined) return snippet.tokenEstimate;
  if (snippet.content !== undefined) return countTokensApprox(snippet.content);
  return countTokensApprox(`${snippet.file}:${snippet.startLine}-${snippet.endLine}`);
}

function rebalanceSourceSnippets(
  snippets: ContextPackSnippetContract[],
  tokenBudget?: number,
): {
  snippets: ContextPackSnippetContract[];
  estimatedTokens: number;
  truncated: boolean;
  limitations: string[];
} {
  const kept: ContextPackSnippetContract[] = [];
  let estimatedTokens = 0;
  let truncated = false;

  for (const snippet of snippets) {
    const tokenEstimate = estimateSnippetTokens(snippet);
    if (tokenBudget !== undefined && estimatedTokens + tokenEstimate > tokenBudget) {
      truncated = true;
      continue;
    }
    estimatedTokens += tokenEstimate;
    kept.push({
      ...snippet,
      tokenEstimate,
    });
  }

  return {
    snippets: kept,
    estimatedTokens,
    truncated,
    limitations: truncated ? [TOKEN_BUDGET_LIMITATION] : [],
  };
}

function symbolsForHunks(root: string, hunks: ContextPackHunkContract[]): ContextPackSymbolContract[] {
  const symbols: ContextPackSymbolContract[] = [];
  const seen = new Set<string>();
  for (const hunk of hunks) {
    const full = join(root, hunk.file);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    const from = Math.max(0, (hunk.newStart ?? 1) - 8);
    const to = Math.min(lines.length, (hunk.newStart ?? 1) + (hunk.newLines ?? 1) + 8);
    for (let idx = from; idx < to; idx++) {
      const line = lines[idx];
      const match = line.match(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (!match) continue;
      const symbolName = match[1];
      const symbolRef = `${hunk.file}:${symbolName}:${idx + 1}`;
      if (seen.has(symbolRef)) continue;
      seen.add(symbolRef);
      symbols.push({
        symbolRef,
        file: hunk.file,
        symbolName,
        kind: line.includes('class ') ? 'class' : line.includes('interface ') ? 'interface' : 'symbol',
        line: idx + 1,
        hunkRefs: [hunk.hunkRef],
        riskTags: riskTagsForFile(hunk.file),
        metadata: {},
      });
    }
  }
  return symbols.sort((a, b) => a.symbolRef.localeCompare(b.symbolRef));
}

export function createVerificationContextPack(input: VerificationContextPackInput): VerificationContextPackResult {
  const baseRef = input.baseRef || 'HEAD';
  const headRef = input.headRef || 'WORKTREE';
  const trackedDiffText = git(input.root, diffArgs(baseRef, headRef));
  const untrackedFiles = listUntrackedFiles(input.root, headRef);
  const diffText = appendUntrackedDiffs(input.root, trackedDiffText, untrackedFiles);
  const changedFiles = uniqueSorted([...listChangedFiles(input.root, baseRef, headRef), ...untrackedFiles]);
  const changedHunks = parseGitDiffHunks(diffText);
  const snippetResult = snippetsForHunks(input.root, changedHunks, input.tokenBudget);
  const changedSymbols = symbolsForHunks(input.root, changedHunks);
  const repoHead = git(input.root, ['rev-parse', 'HEAD']);
  const dirty = git(input.root, ['status', '--porcelain']).length > 0;
  const riskTags = [...new Set([...changedFiles.flatMap(riskTagsForFile), ...changedHunks.flatMap(h => h.riskTags ?? [])])].sort();

  const pack: VerificationContextPackContract = {
    packId: input.packId || `vcp-${sha256(`${input.producerRunId}:${input.storyId ?? ''}:${baseRef}:${headRef}:${diffText}`).slice(0, 16)}`,
    producerRunId: input.producerRunId,
    storyId: input.storyId,
    baseRef,
    headRef,
    repo: { headHash: repoHead, dirty, materialHash: sha256(diffText) },
    diffHash: digestCanonical({ diff: diffText }),
    changedFiles,
    changedHunks,
    changedSymbols,
    impactedFiles: changedFiles,
    impactedSymbols: [],
    dependencyEdges: [],
    sourceSnippets: snippetResult.snippets,
    checklistItemIds: input.checklistItemIds ?? [],
    testIntentRefs: input.testIntentRefs ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    requiredCommands: input.requiredCommands ?? [],
    oracleRefs: input.oracleRefs ?? [],
    riskTags,
    requiredRefs: input.requiredRefs ?? [],
    excludedPaths: input.excludedPaths ?? [],
    limitations: snippetResult.truncated ? [TOKEN_BUDGET_LIMITATION] : [],
    tokenBudget: input.tokenBudget,
    estimatedTokens: snippetResult.estimatedTokens,
    truncated: snippetResult.truncated,
    metadata: input.metadata ?? {},
  };

  return {
    pack,
    packDigest: digestVerificationContextPack(pack),
    diffText,
  };
}

export function createVerificationContextPackExpansion(
  parent: VerificationContextPackContract,
  input: VerificationContextPackExpansionInput,
): { pack: VerificationContextPackContract; packDigest: string; parentPackDigest: string } {
  const normalizedParent = parseVerificationContextPackContract(parent, 'verification_context_pack_expand: parentPack');
  const expansionReason = input.expansionReason.trim();
  if (expansionReason.length < 10) {
    throw new Error('verification_context_pack_expand: expansionReason must explain the expansion (>= 10 chars)');
  }
  const tokenBudget = input.tokenBudget ?? normalizedParent.tokenBudget;
  const snippetResult = rebalanceSourceSnippets(
    [...(normalizedParent.sourceSnippets ?? []), ...(input.sourceSnippets ?? [])],
    tokenBudget,
  );
  const limitations = [
    ...(normalizedParent.limitations ?? []).filter(limitation => limitation !== TOKEN_BUDGET_LIMITATION),
    ...snippetResult.limitations,
  ];
  const parentPackDigest = digestVerificationContextPack(normalizedParent);
  const pack: VerificationContextPackContract = {
    ...normalizedParent,
    packId: input.packId || `${normalizedParent.packId}-expansion-${sha256(expansionReason).slice(0, 8)}`,
    impactedFiles: [...new Set([...(normalizedParent.impactedFiles ?? []), ...(input.impactedFiles ?? [])])].sort(),
    impactedSymbols: [...(normalizedParent.impactedSymbols ?? []), ...(input.impactedSymbols ?? [])],
    dependencyEdges: [...(normalizedParent.dependencyEdges ?? []), ...(input.dependencyEdges ?? [])],
    sourceSnippets: snippetResult.snippets,
    requiredRefs: [...new Set([...(normalizedParent.requiredRefs ?? []), ...(input.requiredRefs ?? [])])].sort(),
    tokenBudget,
    estimatedTokens: snippetResult.estimatedTokens,
    truncated: snippetResult.truncated,
    limitations,
    parentPackDigest,
    expansionReason,
    metadata: { ...(normalizedParent.metadata ?? {}), ...(input.metadata ?? {}) },
  };
  return {
    pack,
    packDigest: digestVerificationContextPack(pack),
    parentPackDigest,
  };
}
