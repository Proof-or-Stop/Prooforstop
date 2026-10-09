import { readFileSync } from 'node:fs';
import type { ZodType } from 'zod';
import { parseFlags } from './flag-parser.js';

/**
 * One parse of a command's raw argv, shared by the CLI engine and the raw
 * runtime-admission gate.
 *
 * Forms: `--key=value` / `--flag` options, a single JSON object payload, or a
 * JSON object payload FOLLOWED by options (`cmd '{"storyId":"B-1"}' --json`).
 * `next` prints the JSON form and owners habitually append `--json`; before
 * run 14's fix the trailing flag made the CLI drop the payload entirely
 * (argument_validation_failed: storyId undefined). The merge is strict: a flag
 * that restates a payload key with a different value is refused, never
 * silently preferred.
 */
export function splitJsonPayload(rawArgs: readonly string[]): { payload: Record<string, unknown>; rest: string[] } | null {
  let first = rawArgs[0];
  // Old-PoS run 31 (D7): `cmd @<file.json>` reads the JSON payload from a file (next
  // writes a long step payload there instead of printing it into the owner's context).
  if (first !== undefined && /^@\S+\.json$/.test(first)) {
    try { first = readFileSync(first.slice(1), 'utf8').trim(); } catch (e) { throw new Error(`JSON payload file ${first.slice(1)} unreadable: ${(e as Error).message}`); }
  }
  if (first === undefined || !first.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch (e) {
    throw new Error(jsonPayloadParseFailure(first, (e as Error).message));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON payload must be an object (got ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}): ${excerpt(first, 0).replace(/\s+/g, ' ')}`);
  }
  return { payload: parsed as Record<string, unknown>, rest: rawArgs.slice(1) };
}

const EXCERPT_RADIUS = 40;

function excerpt(input: string, position: number): string {
  const start = Math.max(0, position - EXCERPT_RADIUS);
  const end = Math.min(input.length, position + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${input.slice(start, end)}${end < input.length ? '…' : ''}`;
}

/**
 * ONE line: the parser error, the payload text around the failing position and
 * the usual cause. Run 16: the full input echo plus ~50 lines of argument help
 * after it left `tail` showing only the help footer, which the owner misread as
 * lease contention (15 failed calls).
 */
export function jsonPayloadParseFailure(input: string, parserMessage: string): string {
  const position = Number(parserMessage.match(/position (\d+)/)?.[1] ?? input.length);
  // A value's closing quote right before the failing position: an unescaped " ended the string early.
  const quoteHint = position > 0 && position < input.length && input[position - 1] === '"'
    ? '; a " inside a JSON string value must be written \\" (or avoid the quote)'
    : '';
  return `JSON parse failed: ${parserMessage.replace(/\s+/g, ' ')} near: ${excerpt(input, position).replace(/\s+/g, ' ')}${quoteHint}`;
}

export function mergeJsonPayloadAndFlags(payload: Record<string, unknown>, flags: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(flags)) {
    if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
      throw new Error(`Conflicting values for "${key}": the JSON payload says ${JSON.stringify(merged[key])} but --${key} says ${JSON.stringify(value)}; pass it once.`);
    }
    merged[key] = value;
  }
  return merged;
}

export function parseCommandArgv(rawArgs: readonly string[], schema: Record<string, ZodType>): Record<string, unknown> {
  if (rawArgs.length === 0) return {};
  const json = splitJsonPayload(rawArgs);
  if (!json) return parseFlags([...rawArgs], schema);
  return json.rest.length === 0 ? json.payload : mergeJsonPayloadAndFlags(json.payload, parseFlags(json.rest, schema));
}
