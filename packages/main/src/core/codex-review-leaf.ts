/**
 * codex-review-leaf — auto-run Codex as an independent, read-only adversarial
 * reviewer over a materialHash-bound change and capture a STRUCTURED verdict.
 *
 * Story B-f57a (Tier-C M1, crypto-deferred). NO cryptography lives here: the
 * value is the adversarial joint decision, not a signature. On a single-machine,
 * same-operator setup tamper-proofing defends against a non-existent adversary,
 * so signed-verdict/pinned-key crypto is deferred as an external-skeptic-only
 * later milestone (see tier-c-crosshost-quorum-execution-plan.md).
 *
 * SPIKE-confirmed mechanism (codex 0.141.0): drive Codex by PIPING the prompt
 * via STDIN to `codex exec -s read-only -C <worktree>` — prompt-as-arg is
 * unreliable (hangs on "Reading additional input from stdin...") and there is NO
 * --prompt-file flag. Codex emits the verdict JSON as its final stdout message.
 * We do our OWN bounded spawn (child_process.spawn + a timeout + stdin write) —
 * NOT runBoundedCodexProvider, which returns only a stdout digest by design and
 * would hide the verdict JSON. We parse ONLY the last structured JSON verdict
 * object out of stdout, discard the rest of the transcript, and record only a
 * stdoutDigest for provenance — raw provider stdout is NEVER surfaced.
 *
 * read-only (`-s read-only`) means Codex cannot modify the code it reviews.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FINDING_SEVERITIES, type Finding } from './adversarial-review.js';

// ── Verdict schema `lattice.codex_review_verdict.v1` ──────────────────────────

export const CODEX_REVIEW_VERDICT_SCHEMA = 'lattice.codex_review_verdict.v1' as const;
export type CodexReviewDecision = 'pass' | 'fail' | 'blocked';

/**
 * The structured verdict Codex is instructed to emit as its final message. The
 * `findings` reuse the frozen `Finding` shape (adversarial-review.ts): severity
 * BLOCKER|MAJOR|MINOR + title/file/line/issue/fix. `materialHash` binds the
 * verdict to the exact change under review; the orchestrator rebinds/validates
 * it against its own computed digest (fail-closed on mismatch).
 */
export interface CodexReviewVerdict {
  schemaVersion: typeof CODEX_REVIEW_VERDICT_SCHEMA;
  decision: CodexReviewDecision;
  materialHash: string;
  findings: Finding[];
  summary: string;
  /**
   * Present ONLY on a synthesized fail-closed verdict; names the fail-closed
   * reason (codex_review_no_parseable_verdict / codex_review_material_mismatch).
   * A genuine Codex verdict never carries this field.
   */
  reason?: string;
}

const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  issue: z.string(),
  fix: z.string(),
});

const verdictSchema = z.object({
  schemaVersion: z.literal(CODEX_REVIEW_VERDICT_SCHEMA),
  decision: z.enum(['pass', 'fail', 'blocked']),
  materialHash: z.string(),
  findings: z.array(findingSchema),
  summary: z.string(),
});

export const CODEX_REVIEW_NO_PARSEABLE_VERDICT = 'codex_review_no_parseable_verdict' as const;
export const CODEX_REVIEW_MATERIAL_MISMATCH = 'codex_review_material_mismatch' as const;
export const CODEX_REVIEW_ABNORMAL_EXIT = 'codex_review_abnormal_exit' as const;

// ── Prompt ────────────────────────────────────────────────────────────────────

export interface BuildCodexReviewPromptOptions {
  storyId: string;
  materialHash: string;
  /** Optional host-A (Claude) findings, surfaced so host B can independently confirm/refute them. */
  hostAFindings?: Finding[];
}

/**
 * A REVIEW-specific prompt (NOT the implementation-flavored dispatchPrompt) that
 * embeds the target materialHash and instructs Codex to act as an independent
 * adversarial reviewer and output ONLY the JSON verdict as its final message —
 * no prose, no fences.
 */
export function buildCodexReviewPrompt(opts: BuildCodexReviewPromptOptions): string {
  const example = JSON.stringify(
    {
      schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA,
      decision: 'pass',
      materialHash: opts.materialHash,
      findings: [
        {
          severity: 'MAJOR',
          title: 'one-line summary',
          file: 'relative/path.ts',
          line: 42,
          issue: 'what is wrong and why it matters',
          fix: 'concrete remediation',
        },
      ],
      summary: 'one-paragraph rationale for the decision',
    },
    null,
    0,
  );
  const hostASection = opts.hostAFindings && opts.hostAFindings.length > 0
    ? [
      '',
      'Host A (Claude) already recorded these findings. Independently confirm or refute each',
      'against the actual code — do not defer to them — and raise any additional issues you find:',
      JSON.stringify(opts.hostAFindings, null, 0),
    ].join('\n')
    : '';
  return [
    'You are an independent, adversarial, READ-ONLY code reviewer (host B).',
    `You are reviewing the change bound to materialHash ${opts.materialHash} in story ${opts.storyId}.`,
    'You cannot and must not modify any file; you only review the current worktree state.',
    '',
    'Adversarially inspect the change for correctness bugs, crash/edge-case defects, missing',
    'tests, security issues, and scope/behavior regressions. A finding is a claim you can cite',
    'against concrete code. Refute by default: only raise a finding you can substantiate.',
    hostASection,
    '',
    'Decision rules:',
    '  - "pass"    → no blocking or major defect found.',
    '  - "fail"    → at least one real BLOCKER/MAJOR defect exists.',
    '  - "blocked" → you cannot complete the review (insufficient context / cannot read the change).',
    '',
    `Set the verdict "materialHash" field to EXACTLY ${opts.materialHash}.`,
    '',
    'Output ONLY a single JSON object as your FINAL message — no prose before or after, no',
    'markdown code fences. It MUST match this schema exactly:',
    example,
  ].filter(line => line !== undefined).join('\n');
}

// ── Process seam ────────────────────────────────────────────────────────────

export interface CodexReviewRunnerOptions {
  prompt: string;
  storyWorktree: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodexReviewRunnerResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Injectable process seam: pipe `prompt` on stdin to a bounded read-only
 * `codex exec` and return raw stdout + exit info. Tests inject a fake so no real
 * CLI is spawned. The default is a real bounded spawn.
 */
export type CodexReviewRunner = (opts: CodexReviewRunnerOptions) => CodexReviewRunnerResult
  | Promise<CodexReviewRunnerResult>;

/**
 * Default real implementation: our OWN bounded spawn (NOT runBoundedCodexProvider).
 * We write the prompt to Codex's stdin, close it, and read stdout to completion or
 * until the timeout fires (SIGKILL). read-only (`-s read-only`) forbids Codex from
 * modifying the reviewed code. Synchronous by blocking on the child via a small
 * spin is avoided — the seam returns a Promise the leaf awaits.
 */
export const defaultCodexReviewRunner: CodexReviewRunner = (opts): Promise<CodexReviewRunnerResult> => {
  return new Promise<CodexReviewRunnerResult>((resolvePromise) => {
    const child = spawn(
      'codex',
      ['exec', '-s', 'read-only', '-C', opts.storyWorktree],
      {
        cwd: opts.storyWorktree,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const MAX_BYTES = 8 * 1024 * 1024;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, exitCode, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BYTES) stdout += chunk.toString('utf8');
    });
    // stderr is intentionally drained and discarded — a provider transcript must
    // never be promoted into evidence.
    child.stderr?.on('data', () => { /* discard */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));

    try {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch {
      // If the pipe is already broken, close/error handlers settle the promise.
    }
  });
};

// ── Verdict extraction + fail-closed leaf ─────────────────────────────────────

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Extract the LAST JSON object in `stdout` that validates against the verdict
 * schema. Codex emits a transcript; the verdict is its final structured message.
 * We scan every balanced top-level `{...}` region, Zod-validate each, and return
 * the last one that matches — everything else (prose, tool logs, fences) is
 * discarded. Returns undefined when no region validates.
 */
export function extractCodexReviewVerdict(stdout: string): CodexReviewVerdict | undefined {
  const candidates = scanBalancedObjects(stdout);
  let match: CodexReviewVerdict | undefined;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = verdictSchema.safeParse(parsed);
    if (result.success) {
      match = { ...result.data };
    }
  }
  return match;
}

/** Return every balanced `{...}` substring at the top brace-nesting level. */
function scanBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

export interface RunCodexReviewLeafOptions {
  storyId: string;
  storyWorktree: string;
  /** The orchestrator-computed materialHash the verdict must bind to. */
  materialHash: string;
  hostAFindings?: Finding[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodexReviewLeafResult {
  hostBVerdict: CodexReviewVerdict;
  /** sha256 of the raw stdout, for provenance only — raw stdout is never returned. */
  stdoutDigest: string;
  exitCode: number | null;
  timedOut: boolean;
}

function synthesizedBlocked(materialHash: string, reason: string, summary: string): CodexReviewVerdict {
  return {
    schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA,
    decision: 'blocked',
    materialHash,
    findings: [],
    summary,
    reason,
  };
}

/**
 * Run the read-only Codex review leaf and return a validated, materialHash-bound
 * verdict. FAIL-CLOSED:
 *   - no parseable/schema-valid verdict → decision 'blocked', reason
 *     `codex_review_no_parseable_verdict`;
 *   - verdict.materialHash !== opts.materialHash (a rebinding attempt / stale
 *     tree) → decision 'blocked', reason `codex_review_material_mismatch`.
 * Never returns raw stdout — only a stdoutDigest for provenance.
 */
export async function runCodexReviewLeaf(
  opts: RunCodexReviewLeafOptions,
  runner: CodexReviewRunner = defaultCodexReviewRunner,
): Promise<CodexReviewLeafResult> {
  const prompt = buildCodexReviewPrompt({
    storyId: opts.storyId,
    materialHash: opts.materialHash,
    ...(opts.hostAFindings ? { hostAFindings: opts.hostAFindings } : {}),
  });
  const outcome = await runner({
    prompt,
    storyWorktree: opts.storyWorktree,
    timeoutMs: opts.timeoutMs,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const stdoutDigest = digest(outcome.stdout);

  // Codex output can only be trusted from a CLEAN completion. A timed-out or
  // non-zero / null (spawn-failure) exit means the review did not finish; even if a
  // schema-valid verdict happens to sit in the partial stdout, fail closed — a killed
  // process's "pass" is not a real reviewer verdict. (Caught by the Codex host-B lane.)
  if (outcome.timedOut || outcome.exitCode !== 0) {
    return {
      hostBVerdict: synthesizedBlocked(
        opts.materialHash,
        CODEX_REVIEW_ABNORMAL_EXIT,
        `Codex review leaf exited abnormally (exitCode=${String(outcome.exitCode)}, timedOut=${outcome.timedOut}); failing closed regardless of stdout content.`,
      ),
      stdoutDigest,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    };
  }

  const parsed = extractCodexReviewVerdict(outcome.stdout);
  if (!parsed) {
    return {
      hostBVerdict: synthesizedBlocked(
        opts.materialHash,
        CODEX_REVIEW_NO_PARSEABLE_VERDICT,
        'No parseable structured verdict was emitted by the Codex review leaf; failing closed.',
      ),
      stdoutDigest,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    };
  }
  if (parsed.materialHash !== opts.materialHash) {
    return {
      hostBVerdict: synthesizedBlocked(
        opts.materialHash,
        CODEX_REVIEW_MATERIAL_MISMATCH,
        `Codex verdict materialHash (${parsed.materialHash}) does not match the reviewed materialHash (${opts.materialHash}); failing closed.`,
      ),
      stdoutDigest,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    };
  }
  return {
    hostBVerdict: parsed,
    stdoutDigest,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  };
}
