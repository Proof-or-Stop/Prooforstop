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
  const first = rawArgs[0];
  if (first === undefined || !first.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}\nInput: ${first}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON payload must be an object\nInput: ${first}`);
  }
  return { payload: parsed as Record<string, unknown>, rest: rawArgs.slice(1) };
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
