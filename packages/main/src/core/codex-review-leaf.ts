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
import {
  isUsageLedgerEnabled,
  recordBudgetBlock,
  recordConcurrencyBlock,
  recordDispatchPreflight,
  recordDispatchUnavailableFinal,
  type DispatchPreflightHandle,
  type DispatchUsageContext,
  type DispatchUsageOptions,
} from './usage-ledger/dispatch-usage.js';
// F-017: lateral core->core import of the host-run admission primitives. Safe
// (no cycle): host-run.ts imports only host-execution-readiness.js and
// usage-ledger/dispatch-usage.js — neither reaches back into this module (the
// codex review leaf is never imported by host-run, verified).
// B-137a: import the EXTRACTED provider-process registry directly rather than
// the deprecated host-run.ts compat aliases (same values, different edge).
// provider-process-registry-smoke asserts this exact import, because routing
// through host-run.ts silently reverts this story's extraction while still
// compiling.
import {
  acquireProviderProcessSlot,
  providerProcessSlotsDir,
  releaseProviderProcessSlotBestEffort,
  resolveProviderProcessMaxConcurrent,
  resolveProviderProcessSlotStaleMs,
  type AcquiredProviderProcessSlot,
} from './provider-process-registry.js';
import { HOST_RUN_REFUSAL_EXIT_CODE } from './host-run.js';

// ── Verdict schema `proof-or-stop.codex_review_verdict.v1` ──────────────────────────

export const CODEX_REVIEW_VERDICT_SCHEMA = 'proof-or-stop.codex_review_verdict.v1' as const;
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
export const CODEX_REVIEW_STDOUT_TRUNCATED = 'codex_review_stdout_truncated' as const;
// F-017: pre-spawn admission refusal reasons (no codex process is ever spawned).
// A budget/concurrency/slot-registry refusal synthesizes a `blocked` verdict
// carrying one of these reasons, so cross_host_review reports hostB decision
// 'blocked' (never a fabricated pass/fail).
export const CODEX_REVIEW_BUDGET_BLOCKED = 'codex_review_budget_blocked' as const;
export const CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED = 'codex_review_concurrency_cap_exceeded' as const;
export const CODEX_REVIEW_SLOT_REGISTRY_ERROR = 'codex_review_slot_registry_error' as const;

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
    'Do not repeat a verdict in progress messages or emit transport events yourself. The CLI may wrap your final object in an agent_message event and append its own turn.completed usage; those transport records are not additional reviewer verdicts.',
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
  /**
   * True when the TOTAL stdout exceeded the runner's retained-memory cap
   * (MAX_BYTES) and later chunks were dropped from `stdout`. When true, the
   * retained `stdout` is a PREFIX only and cannot be trusted as the final
   * content — the leaf must fail closed. OPTIONAL (defaults to false) so
   * existing injectable fakes that omit it keep compiling.
   */
  truncated?: boolean;
  /**
   * OPTIONAL honest sha256 hex of the TRUE raw stdout stream (every byte,
   * even beyond MAX_BYTES). When present the leaf uses this for provenance
   * instead of hashing the possibly-truncated retained `stdout`. Fakes that
   * omit it fall back to hashing the provided `stdout`.
   */
  stdoutDigest?: string;
  /** True when the runner refused before spawning a provider process. */
  blocked?: boolean;
  /** Canonical HostRun refusal classification, when blocked. */
  refusalReason?: string | null;
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
    let truncated = false;
    const MAX_BYTES = 8 * 1024 * 1024;
    // Hash EVERY byte received (even beyond the retained-memory cap) so the
    // stdoutDigest is honest — a digest of the true raw stream, not just the
    // retained prefix. Otherwise an adversary could pad past the cap and the
    // digest would silently only cover the (accepted) prefix.
    const fullStreamHash = createHash('sha256');

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, exitCode, timedOut, truncated, stdoutDigest: fullStreamHash.digest('hex') });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      // Feed the honest full-stream hash first (every byte, even past the cap).
      fullStreamHash.update(chunk);
      if (stdout.length < MAX_BYTES) stdout += chunk.toString('utf8');
      else truncated = true;
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
 *   2. Bug14 (HIGH — duplicate same-decision verdicts): there must be EXACTLY
 *      ONE schema-valid verdict object in the entire stdout. A correct run emits
 *      exactly one verdict, so ANY second schema-valid verdict — REGARDLESS of
 *      whether its `decision` matches — makes the output ambiguous → return
 *      undefined (fail closed). The earlier rule only failed closed on CONFLICTING
 *      decisions, so an earlier `pass` carrying findings plus a later clean `pass`
 *      was accepted (the earlier one silently discarded). We never silently pick
 *      one, and we never trust a transcript that contains more than one verdict.
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
 * Managed --json output instead requires one completed turn with exactly one
 * whole schema-valid agent_message verdict, followed only by turn.completed.
 * Tool output never supplies a verdict. Failed, mixed, malformed or unknown
 * event streams and any assistant/tool activity after the verdict are refused.
 * Returns undefined when there is no admissible trailing verdict.
 */
export function extractCodexReviewVerdict(stdout: string): CodexReviewVerdict | undefined {
  const lines = stdout.split(/\r?\n/u).filter(line => line.trim().length > 0);
  const records = lines.map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  });
  // The managed launcher uses --json. Never scan an event's embedded tool text
  // as a verdict or mistake the trailing turn.completed usage for model output.
  const isEvent = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (records.some(record => isEvent(record) && typeof record.type === 'string'
    && /^(?:thread\.|turn\.|item\.|error$)/u.test(record.type))) {
    let started = false;
    let completed = false;
    let threadSeen = false;
    let verdict: CodexReviewVerdict | undefined;
    for (const record of records) {
      if (!isEvent(record) || completed) return undefined;
      if (record.type === 'thread.started') {
        if (threadSeen || started || typeof record.thread_id !== 'string' || !record.thread_id) return undefined;
        threadSeen = true;
      } else if (record.type === 'turn.started') {
        if (started) return undefined;
        started = true;
      } else if (record.type === 'turn.completed') {
        if (!started || !verdict) return undefined;
        completed = true;
      } else if (['item.started', 'item.updated', 'item.completed'].includes(String(record.type))) {
        if (!started || verdict || !isEvent(record.item) || typeof record.item.type !== 'string') return undefined;
        if (record.type !== 'item.completed' || record.item.type !== 'agent_message') continue;
        if (typeof record.item.text !== 'string') return undefined;
        const text = record.item.text.trim();
        const candidate = parseVerdict(text);
        if (candidate) verdict = candidate;
        else if (text.includes(CODEX_REVIEW_VERDICT_SCHEMA)) return undefined;
        // Ordinary pre-verdict assistant progress is not evidence. A later
        // assistant/tool item after any verdict is rejected above, even if a
        // second verdict would agree with the first.
      } else {
        // Error/failed turns, unknown event types, mixed raw/event transcripts,
        // and extra turns cannot be converted into a successful final result.
        return undefined;
      }
    }
    return completed ? verdict : undefined;
  }
  return extractPlainCodexReviewVerdict(stdout);
}

function extractPlainCodexReviewVerdict(stdout: string): CodexReviewVerdict | undefined {
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

  // (2) Bug14 ambiguity guard: a correct run emits EXACTLY ONE verdict. If ANY OTHER
  // balanced object is ALSO a schema-valid verdict — regardless of whether its
  // decision matches — the transcript carries more than one verdict and is
  // ambiguous → fail closed. (Tightened from "fail only on a DIFFERENT decision":
  // an earlier `pass` with findings plus a later clean `pass` must not silently
  // discard the earlier one and be trusted.)
  for (let i = 0; i < objects.length - 1; i += 1) {
    if (parseVerdict(objects[i].text)) return undefined;
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

/**
 * B-70e9 CHK-003: optional usage-ledger binding for the codex review leaf. When
 * present, the leaf writes a preflight estimate (over the review PROMPT) before the
 * spawn and an UNAVAILABLE final after it, so the cross-host review's codex spawn is
 * at least VISIBLE in the usage ledger. The codex argv is NOT changed — `codex exec
 * -s read-only` has NO `--json` event stream, so stdout carries no usage; the final
 * reason documents exactly that (`codex_exec_plain_stdout_no_usage_events`).
 *
 * `env` here is the UNREDACTED ledger-gating env (the caller's process env), which is
 * DISTINCT from RunCodexReviewLeafOptions.env — that latter env is the redacted,
 * closed-allowlist environment the codex subprocess sees and MUST NOT be used for
 * ledger gating (it deliberately drops PROOF_OR_STOP_USAGE_LEDGER). Absent => no usage
 * rows; canonical provider-process admission and registry I/O remain mandatory.
 *
 * B-137a: do NOT restate this as "byte-identical when the ledger is off". Usage
 * accounting is a diagnostic; the cross-provider concurrency/supervision boundary
 * is not. Turning off the ledger must never turn off admission.
 */
export interface CodexReviewLeafUsageLedger {
  root: string;
  recordedAt: string;
  projectRootHash: string;
  env: NodeJS.ProcessEnv;
  phase: string;
}

export const CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON = 'codex_exec_plain_stdout_no_usage_events' as const;
export const CROSS_HOST_REVIEW_CODEX_AGENT_TYPE = 'cross-host-review:codex' as const;
export const CROSS_HOST_REVIEW_CODEX_COMMAND = 'cross-host-review:codex' as const;

export interface RunCodexReviewLeafOptions {
  storyId: string;
  storyWorktree: string;
  /** The orchestrator-computed materialHash the verdict must bind to. */
  materialHash: string;
  hostAFindings?: Finding[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** B-70e9 CHK-003: optional usage-ledger binding (see CodexReviewLeafUsageLedger). */
  usageLedger?: CodexReviewLeafUsageLedger;
  /**
   * B-137a: admission + provider process ownership are supplied by the durable
   * ManagedHostRun worker. The leaf must NOT acquire a second slot for the same
   * spawn, or the managed run deadlocks against its own concurrency cap.
   */
  managedExecution?: boolean;
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
 * F-017: the fail-closed leaf result for a PRE-SPAWN admission refusal (hard
 * budget / concurrency cap / slot-registry error). No codex process was ever
 * spawned, so the result is fully synthesized:
 *   - hostBVerdict is a `decision: 'blocked'` verdict whose `reason` names the
 *     refusal — cross_host_review therefore reports hostB decision 'blocked'
 *     and jointDecision 'blocked' (never a fabricated 'pass'/'fail'). The
 *     verdict binds `materialHash` to the reviewed materialHash, so the joint
 *     decision's material binding sees NO mismatch (the block is honestly
 *     attributed to "host B decision is blocked", not divergent code states).
 *   - stdoutDigest is the honest digest of an EMPTY stream (no bytes were read).
 *   - exitCode is the host-run refusal sentinel (3) — the SAME sentinel a
 *     host_run / autopilot-repair cap refusal reports, so all three
 *     proof-or-stop-initiated spawn refusals surface identically. timedOut is false
 *     (a refusal is not a timeout).
 */
function blockedLeafResult(materialHash: string, reason: string, summary: string): CodexReviewLeafResult {
  return {
    hostBVerdict: synthesizedBlocked(materialHash, reason, summary),
    stdoutDigest: digest(''),
    exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
    timedOut: false,
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

  // B-70e9 CHK-003: usage-ledger preflight over the review prompt (fail-open; strict
  // no-op when the ledger is OFF or no binding was supplied). The codex argv below is
  // untouched — this only makes the spawn visible in the ledger.
  const ledger = opts.usageLedger;
  const ledgerOn = ledger !== undefined && isUsageLedgerEnabled(ledger.env);
  let ledgerCtx: DispatchUsageContext | null = null;
  let ledgerOpts: DispatchUsageOptions | null = null;
  let ledgerHandle: DispatchPreflightHandle | null = null;
  // F-017: the pre-spawn admission slot (the canonical provider-process registry).
  // Acquired below OUTSIDE the ledger gate and released in the finally around the
  // runner. It is null only when the managed worker already owns admission for
  // this exact spawn (opts.managedExecution); disabling usage accounting never
  // disables admission.
  let admissionSlot: AcquiredProviderProcessSlot | null = null;
  if (ledgerOn && ledger) {
    ledgerCtx = {
      storyId: opts.storyId,
      phase: ledger.phase,
      agentType: CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
    };
    ledgerOpts = {
      recordedAt: ledger.recordedAt,
      projectRootHash: ledger.projectRootHash,
      command: CROSS_HOST_REVIEW_CODEX_COMMAND,
      host: { kind: 'codex' },
      env: ledger.env,
    };
    try {
      ledgerHandle = recordDispatchPreflight(ledger.root, ledgerCtx, prompt, ledgerOpts);
    } catch {
      ledgerHandle = null;
    }

    // F-017: the codex review leaf is a proof-or-stop-initiated host spawn, so — AFTER
    // the preflight and BEFORE the runner — it passes the SAME pre-spawn
    // admission as runHostRun / the autopilot repair (budget -> concurrency ->
    // spawn). A refusal records the appropriate blocked ledger row and returns a
    // SYNTHESIZED fail-closed 'blocked' verdict WITHOUT invoking the runner, so
    // cross_host_review yields hostB decision 'blocked' (never a fabricated
    // 'pass'/'fail') and a jointDecision 'blocked'. Provider-process admission is
    // mandatory and lives outside the ledger gate; only usage-ledger bookkeeping
    // stays conditional on ledger ON.
    //
    // (1) Hard-budget admission (fail-closed; the blocked row is written inside
    // recordBudgetBlock, which never throws). A codex review leaf is a codex
    // launch, so the openai provider binding mirrors host_run's codex path.
    const budget = recordBudgetBlock(ledger.root, ledgerCtx, ledgerHandle, prompt, ledgerOpts, { name: 'openai', model: null });
    if (budget.blocked) {
      return blockedLeafResult(
        opts.materialHash,
        CODEX_REVIEW_BUDGET_BLOCKED,
        `Codex review leaf refused pre-spawn: hard_budget_exceeded (${budget.budgetPolicyId ?? 'hard-budget'}${
          budget.hardBudgetTokens !== null ? `, cap ${budget.hardBudgetTokens}` : ''
        }); the codex runner was never invoked.`,
      );
    }

  }


  // B-137a: provider-process admission is MANDATORY and therefore lives OUTSIDE
  // the ledger gate. Usage accounting is a diagnostic; the cross-provider
  // concurrency/supervision boundary is not, so disabling the ledger must never
  // disable admission. When there is no ledger binding, fall back to the story
  // worktree + the caller env for the registry location and cap resolution.
  const admissionRoot = ledger?.root ?? opts.storyWorktree;
  const admissionEnv = ledger?.env ?? opts.env ?? process.env;
  // (2) Concurrency admission via the SAME atomic fixed-slot registry as
  // host_run: acquire before the spawn, release in the finally below. On a cap
  // refusal, record the concurrency blocked row and return WITHOUT spawning. A
  // slot-registry error also refuses fail-closed (an admission error must never
  // grant an unguarded spawn) but does NOT fabricate a concurrency_cap_exceeded
  // row for a refusal that was not a cap decision — same doctrine as F-016.
  const cap = resolveProviderProcessMaxConcurrent(admissionEnv);
  let registryError: string | null = null;
  // B-137a: under managed execution the ManagedHostRun worker already holds the
  // admission slot for this exact spawn. Acquiring a second one would count the
  // same provider process twice against the cap and deadlock the managed run,
  // so skip acquisition AND its refusal branch entirely (the worker, not the
  // leaf, is the admission authority here).
  if (!opts.managedExecution) {
  try {
    admissionSlot = acquireProviderProcessSlot(providerProcessSlotsDir(admissionRoot), cap, resolveProviderProcessSlotStaleMs(admissionEnv), Date.now(), {
      pid: process.pid,
      startedAt: ledger?.recordedAt ?? new Date().toISOString(),
      host: 'codex',
      storyId: opts.storyId,
      agentType: CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
    });
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
    admissionSlot = null;
  }
  if (admissionSlot === null) {
    if (registryError !== null) {
      return blockedLeafResult(
        opts.materialHash,
        CODEX_REVIEW_SLOT_REGISTRY_ERROR,
        `Codex review leaf refused pre-spawn: provider-process slot registry error (${registryError}); refusing fail-closed, the codex runner was never invoked.`,
      );
    }
    if (ledgerOn && ledger && ledgerCtx && ledgerOpts) {
      recordConcurrencyBlock(ledger.root, ledgerCtx, ledgerHandle, prompt, cap, ledgerOpts, { name: 'openai', model: null });
    }
    return blockedLeafResult(
      opts.materialHash,
      CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED,
      `Codex review leaf refused pre-spawn: concurrency_cap_exceeded (cap ${cap}, every provider-process slot held by a live run); the codex runner was never invoked.`,
    );
  }
  }

  let outcome: CodexReviewRunnerResult;
  try {
    outcome = await runner({
      prompt,
      storyWorktree: opts.storyWorktree,
      timeoutMs: opts.timeoutMs,
      ...(opts.env ? { env: opts.env } : {}),
    });
  } finally {
    // F-017: release the admission slot exactly like host_run / the autopilot
    // repair — token-verified (F-025; a reclaimed+reacquired slot is never
    // deleted), best-effort (pid-death / the orphan backstop reclaims a leak).
    // null (no slot acquired, including managedExecution) is a no-op.
    releaseProviderProcessSlotBestEffort(admissionSlot ? admissionSlot.file : null, admissionSlot ? admissionSlot.token : null);
  }

  // B-70e9 CHK-003: unavailable final superseding the preflight estimate — the codex
  // review leaf's plain stdout carries no usage event stream, so we never fabricate a
  // count. Fail-open: a ledger error must never break the review.
  if (ledgerOn && ledger && ledgerCtx && ledgerOpts) {
    try {
      recordDispatchUnavailableFinal(
        ledger.root,
        ledgerCtx,
        ledgerHandle?.correlation ?? null,
        ledgerHandle?.estimateRecordId ?? null,
        { name: 'openai', model: 'unknown' },
        CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON,
        ledgerOpts,
      );
    } catch {
      // The seam never breaks the review.
    }
  }
  // Honest provenance digest: prefer the runner's full-stream hash (every byte,
  // even beyond the retained-memory cap) when present; otherwise hash the provided
  // stdout. This keeps the digest true even when the retained stdout is a truncated
  // prefix — the digest must never silently cover only the accepted prefix.
  const stdoutDigest = outcome.stdoutDigest ?? digest(outcome.stdout);

  // Codex output can only be trusted from a CLEAN completion. A timed-out or
  // non-zero / null (spawn-failure) exit means the review did not finish; even if a
  // schema-valid verdict happens to sit in the partial stdout, fail closed — a killed
  // process's "pass" is not a real reviewer verdict. (Caught by the Codex host-B lane.)
  if (outcome.blocked === true) {
    const refusal = outcome.refusalReason ?? 'blocked';
    const reasonCode = refusal === 'concurrency_cap_exceeded'
      ? CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED
      : refusal === 'hard_budget_exceeded'
        ? CODEX_REVIEW_BUDGET_BLOCKED
        : CODEX_REVIEW_SLOT_REGISTRY_ERROR;
    return {
      hostBVerdict: synthesizedBlocked(
        opts.materialHash,
        reasonCode,
        `Codex review leaf refused before spawn (${refusal}); failing closed without treating admission as a provider exit.`,
      ),
      stdoutDigest,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    };
  }
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

  // STDOUT TRUNCATION integrity guard (HIGH — Codex host-B lane fix): if the total
  // stdout exceeded the runner's retained-memory cap, later chunks were dropped, so
  // the retained stdout is only a PREFIX. An adversarial run could emit a valid `pass`
  // verdict, then enough allowed padding to reach the cap, then DISQUALIFYING trailing
  // text that would normally force fail-closed — but that trailing text is gone. We
  // therefore CANNOT prove the parsed verdict was the final content, so we fail closed
  // BEFORE trusting any parsed verdict. (The stdoutDigest above is already the honest
  // full-stream hash, so provenance still binds the true raw stdout.)
  if (outcome.truncated === true) {
    return {
      hostBVerdict: synthesizedBlocked(
        opts.materialHash,
        CODEX_REVIEW_STDOUT_TRUNCATED,
        'Codex review leaf stdout exceeded the retained-memory cap and was truncated; the verdict cannot be proven to be the final content, so failing closed regardless of any parsed verdict.',
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
