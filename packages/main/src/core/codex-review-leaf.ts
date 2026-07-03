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

// STRICT schemas (Bug9 fix): `.strict()` REJECTS unknown keys instead of silently
// stripping them. A non-strict `.object()` would accept a verdict that carries the
// valid required fields PLUS extra contradictory keys (e.g. a second `decision`, an
// injected `override`) and drop the extras — so a tampered/padded verdict would be
// treated as clean. With `.strict()` any unknown key makes safeParse FAIL, so
// extraction returns undefined and the leaf fails closed with no_parseable_verdict.
// This is a defense-in-depth trust-boundary hardening of the untrusted codex stdout.
const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  issue: z.string(),
  fix: z.string(),
}).strict();

const verdictSchema = z.object({
  schemaVersion: z.literal(CODEX_REVIEW_VERDICT_SCHEMA),
  decision: z.enum(['pass', 'fail', 'blocked']),
  materialHash: z.string(),
  findings: z.array(findingSchema),
  summary: z.string(),
}).strict();

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
    '',
    'The JSON verdict MUST be the VERY LAST content you emit. Do NOT write anything after it —',
    'no prose, no disclaimer, no correction, no second JSON object, no trailing sentence. Any',
    'text emitted after the JSON verdict causes the review to fail closed and be discarded.',
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
 * Extract the trailing schema-valid verdict from `stdout`. Codex emits a
 * transcript; the verdict MUST be its final structured message. This is
 * deliberately fail-closed and NON-fragile:
 *
 *   1. The schema-valid verdict must be the LAST balanced top-level `{...}`
 *      object in stdout. If the last balanced object is NOT schema-valid (e.g.
 *      a different/trailing JSON object was emitted after the verdict), we do
 *      NOT scan backwards past it — we return undefined (fail closed). "The
 *      verdict is the final structured message" would otherwise be violated: a
 *      clean pass followed by more content must never be trusted as pass.
 *   2. If TWO OR MORE schema-valid verdict objects carry DIFFERENT `decision`
 *      values, the output is ambiguous/conflicting → return undefined. We never
 *      silently pick one.
 *   3. Real codex exec output may append a small amount of trailing HARNESS
 *      metadata after the model's final message (whitespace, bare token-count
 *      noise like `tokens used` / a lone number). That STRICT allowlist is
 *      tolerated. ANY other trailing content — a trailing JSON OBJECT, a stray
 *      word, a terse lowercase trailer (`actually fail` / `disregard`), or a
 *      sentence — makes the verdict no longer the final content and MUST fail
 *      closed. (Flipped from "reject if it looks like a sentence" to "reject
 *      unless it is known-harmless harness noise" — the root fix for terse
 *      trailers the old heuristic let through.)
 *
 * Returns undefined when there is no admissible trailing verdict.
 */
export function extractCodexReviewVerdict(stdout: string): CodexReviewVerdict | undefined {
  // (3a) Strip trailing whitespace before locating the final structured object.
  const trimmed = stdout.replace(/\s+$/u, '');
  const objects = scanBalancedObjects(trimmed);
  if (objects.length === 0) return undefined;

  const last = objects[objects.length - 1];

  // (3b) Anything AFTER the last balanced object must be KNOWN-HARMLESS harness
  // noise (strict allowlist: whitespace + bare token count / `tokens used`). By
  // construction no OTHER balanced object can follow the last one, so the tail is
  // free-text; reject any tail that is not on the harness allowlist — including
  // terse trailers like `actually fail` / `disregard verdict` — fail closed.
  const tail = trimmed.slice(last.end);
  if (!isTolerableTrailingHarness(tail)) return undefined;

  // (1) The LAST balanced object must itself be the schema-valid verdict. If it is
  // not, fail closed — do NOT reach backwards past a trailing invalid object.
  const lastVerdict = parseVerdict(last.text);
  if (!lastVerdict) return undefined;

  // (2) Ambiguity guard: if any OTHER balanced object is also a schema-valid verdict
  // with a DIFFERENT decision, the transcript is conflicting → fail closed.
  for (let i = 0; i < objects.length - 1; i += 1) {
    const other = parseVerdict(objects[i].text);
    if (other && other.decision !== lastVerdict.decision) return undefined;
  }

  return lastVerdict;
}

/** Zod-validate one candidate substring as a verdict; undefined if it does not match. */
function parseVerdict(candidate: string): CodexReviewVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  const result = verdictSchema.safeParse(parsed);
  return result.success ? { ...result.data } : undefined;
}

/**
 * STRICT trailing-content contract (root fix — replaces the lax `looksLikeSentence`
 * heuristic). After the last balanced verdict object, trailing content is admissible
 * ONLY when every non-empty line is KNOWN-HARMLESS harness noise matching a strict
 * allowlist:
 *   - a bare number / comma-grouped number (a lone token count, e.g. `1,234`);
 *   - the literal token-count line `tokens used` (optionally `tokens used: 1234`).
 * ANY other trailing content — a stray word, a terse lowercase trailer like
 * `actually fail` or `disregard`, a sentence, or another JSON object — makes this
 * return false so extraction fails closed. The logic is flipped from "reject if it
 * LOOKS LIKE a sentence" to "reject UNLESS it is on the known-harmless allowlist":
 * a heuristic can be evaded by short terse trailers (`actually fail` is only two
 * words, no terminal punctuation), but an allowlist cannot — anything unrecognized
 * is rejected. This stays codex-version-agnostic by matching the shape of genuine
 * harness bookkeeping, not a specific version string.
 */
const HARNESS_NOISE_LINE_PATTERNS: readonly RegExp[] = [
  // A bare (optionally comma-grouped) number: a lone token count like `1234` / `1,234`.
  /^\d{1,3}(,\d{3})*$/u,
  /^\d+$/u,
  // The token-count bookkeeping line, with or without a trailing count.
  /^tokens used$/iu,
  /^tokens used:\s*\d{1,3}(,\d{3})*$/iu,
  /^tokens used:\s*\d+$/iu,
];

function isTolerableTrailingHarness(tail: string): boolean {
  const lines = tail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const line of lines) {
    if (!HARNESS_NOISE_LINE_PATTERNS.some(pattern => pattern.test(line))) return false;
  }
  return true;
}

interface BalancedObject { text: string; start: number; end: number; }

/**
 * Return every balanced `{...}` substring at the top brace-nesting level, with the
 * character offsets `[start, end)` at which it occurs in `text` (end is exclusive).
 */
function scanBalancedObjects(text: string): BalancedObject[] {
  const objects: BalancedObject[] = [];
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
          objects.push({ text: text.slice(start, i + 1), start, end: i + 1 });
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
