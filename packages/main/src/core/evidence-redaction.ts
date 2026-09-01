// Runtime content-redaction pass for unattended-development evidence (§B4a of
// proof-or-stop-authority-live-integration.md). Before any stdout / stderr / provider
// prompt / provider response / command output / note is uploaded as evidence,
// it must pass through this redaction pipeline so that access tokens, private
// keys, session cookies, Authorization headers, password values, and raw
// credential assignments are NEVER uploaded as readable evidence.
//
// Design principles:
//   - fail-safe: when in doubt, over-redact. A false positive (an extra
//     `[REDACTED]`) is cheap; a leaked secret is not.
//   - digest preservation: the summary keeps the sha256 of the ORIGINAL content
//     so a verifier can still match the unredacted local artifact's digest
//     (§B4a: "the record must include a redactionSummary and the digest of the
//     unredacted local artifact"). The redacted text never carries the secret.
//   - pure: no I/O, no clock, no env mutation. The executor / upload path calls
//     these functions; the engine itself is deterministic and testable.

import { createHash } from 'node:crypto';

export const REDACTION_PLACEHOLDER = '[REDACTED]';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

interface RedactionRule {
  /** Stable rule id surfaced in the redaction summary. */
  name: string;
  /** Global-flagged matcher. Each rule is applied once, left-to-right. */
  pattern: RegExp;
  /** Replacement string (supports `$1` group refs). Defaults to the placeholder. */
  replacement?: string;
}

// Order matters only for readability of the output — every rule redacts, so a
// value matched by two rules is redacted either way. Structured blocks
// (private keys, headers, cookies) come first, then named secret assignments,
// then bare token shapes.
const REDACTION_RULES: readonly RedactionRule[] = [
  // PEM private key blocks (RSA / EC / OPENSSH / generic).
  {
    name: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // Authorization / Proxy-Authorization headers — preserve the header name, drop
  // the ENTIRE value to end of line (a single token would leave the credential
  // after the scheme, e.g. "Authorization: Bearer <token>").
  {
    name: 'authorization_header',
    pattern: /\b(Authorization|Proxy-Authorization)(\s*:\s*).+/gi,
    replacement: `$1$2${REDACTION_PLACEHOLDER}`,
  },
  // Bearer / Basic credential schemes wherever they appear (not only in headers).
  { name: 'bearer_scheme', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: `Bearer ${REDACTION_PLACEHOLDER}` },
  { name: 'basic_scheme', pattern: /\bBasic\s+[A-Za-z0-9+/=]+/gi, replacement: `Basic ${REDACTION_PLACEHOLDER}` },
  // Cookie / Set-Cookie header values (session cookies).
  {
    name: 'cookie_header',
    pattern: /\b(Set-Cookie|Cookie)(\s*:\s*).*/gi,
    replacement: `$1$2${REDACTION_PLACEHOLDER}`,
  },
  // Named secret assignments in JSON: "...token...": "value".
  {
    name: 'json_secret_assignment',
    pattern: /"([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|actor[_-]?key|private[_-]?key|session|credential|cookie)[A-Za-z0-9_]*)"(\s*:\s*)"[^"]*"/gi,
    replacement: `"$1"$2"${REDACTION_PLACEHOLDER}"`,
  },
  // Named secret assignments in env / kv form: NAME_TOKEN=value or name-secret: value.
  {
    name: 'kv_secret_assignment',
    pattern: /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|actor[-_]?key|private[-_]?key|session|credential|cookie)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\r\n;]+)/gi,
    replacement: `$1$2${REDACTION_PLACEHOLDER}`,
  },
  // Well-known opaque token shapes (provider-issued credentials).
  { name: 'aws_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
  { name: 'github_token', pattern: /\b(?:gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  // JWT (header.payload.signature) — three base64url segments.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

export interface RedactionRuleHit {
  rule: string;
  count: number;
}

export interface RedactionSummary {
  /** True when at least one rule matched (material evidence changed). */
  redacted: boolean;
  /** Per-rule match counts, in rule-application order. */
  ruleHits: RedactionRuleHit[];
  /** sha256 of the ORIGINAL (unredacted) content — lets a verifier match the local artifact digest. */
  originalDigest: string;
  /** sha256 of the redacted content actually uploaded. */
  redactedDigest: string;
  /** Byte length of the original content. */
  originalBytes: number;
}

export interface RedactionResult {
  text: string;
  summary: RedactionSummary;
}

/**
 * Run the redaction pipeline over a single text blob.
 * Returns the redacted text plus a summary that preserves the original digest.
 */
export function redactText(content: string): RedactionResult {
  const original = content ?? '';
  let text = original;
  const ruleHits: RedactionRuleHit[] = [];

  for (const rule of REDACTION_RULES) {
    const counter = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matchCount = (text.match(counter) ?? []).length;
    if (matchCount === 0) continue;
    const replacer = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(replacer, rule.replacement ?? REDACTION_PLACEHOLDER);
    ruleHits.push({ rule: rule.name, count: matchCount });
  }

  return {
    text,
    summary: {
      redacted: ruleHits.length > 0,
      ruleHits,
      originalDigest: sha256Hex(original),
      redactedDigest: sha256Hex(text),
      originalBytes: Buffer.byteLength(original, 'utf8'),
    },
  };
}

/** The text-bearing evidence fields the unattended executor may upload. */
export interface RedactableEvidence {
  stdout?: string;
  stderr?: string;
  prompt?: string;
  response?: string;
  note?: string;
  transcript?: string;
  commandOutput?: string;
}

export interface RedactedEvidence {
  evidence: RedactableEvidence;
  summary: RedactionSummary;
}

const REDACTABLE_FIELDS: readonly (keyof RedactableEvidence)[] = [
  'stdout', 'stderr', 'prompt', 'response', 'note', 'transcript', 'commandOutput',
];

/**
 * Redact every text-bearing field of an evidence record before upload, returning
 * the redacted record and a single merged summary across all fields.
 */
export function redactEvidence(input: RedactableEvidence): RedactedEvidence {
  const out: RedactableEvidence = {};
  const summaries: RedactionSummary[] = [];
  for (const field of REDACTABLE_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const { text, summary } = redactText(value);
    out[field] = text;
    summaries.push(summary);
  }
  return { evidence: out, summary: mergeRedactionSummaries(summaries) };
}

/** Merge per-field summaries into one record-level summary (rule hits summed by rule). */
export function mergeRedactionSummaries(summaries: readonly RedactionSummary[]): RedactionSummary {
  const hitsByRule = new Map<string, number>();
  let originalBytes = 0;
  // Order rule hits by first appearance across the merged summaries.
  const order: string[] = [];
  for (const s of summaries) {
    originalBytes += s.originalBytes;
    for (const hit of s.ruleHits) {
      if (!hitsByRule.has(hit.rule)) order.push(hit.rule);
      hitsByRule.set(hit.rule, (hitsByRule.get(hit.rule) ?? 0) + hit.count);
    }
  }
  const ruleHits = order.map(rule => ({ rule, count: hitsByRule.get(rule)! }));
  // The merged digests cover the concatenation of original/redacted fields so the
  // merged summary is itself a stable, verifiable fingerprint of the batch.
  const concatOriginal = summaries.map(s => s.originalDigest).join('|');
  const concatRedacted = summaries.map(s => s.redactedDigest).join('|');
  return {
    redacted: ruleHits.length > 0,
    ruleHits,
    originalDigest: sha256Hex(concatOriginal),
    redactedDigest: sha256Hex(concatRedacted),
    originalBytes,
  };
}

/**
 * Project environment variables to evidence-safe REFERENCES (names only, never
 * values). §B4a requires environment references in evidence, not raw env values.
 * Returns a sorted, de-duplicated list of variable names.
 */
export function projectEnvReferences(env: NodeJS.ProcessEnv): string[] {
  return Array.from(new Set(Object.keys(env))).sort();
}
