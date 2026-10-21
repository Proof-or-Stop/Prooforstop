/**
 * Lab run132 (bench-staging/oldpos/run132-analysis.md I1, ~3.3 min): `story_update '{"storyId":...,"background":...}'`
 * printed "Story B-9169 updated" and wrote nothing. The CLI validates a non-strict command with `z.object(schema)`, which
 * strips a key the schema does not declare, so the edit was lost and reported as a success; the INIT product reviewer
 * flagged the unchanged background again (one more reviewer round) and the owner spent 1.7 min finding `background_set`.
 *
 * For the Story-metadata editors (a key they drop is an edit that silently did not happen) an undeclared key is a
 * refusal before anything is written (`[unknown_argument]`), naming what takes it: a declared argument it is a typo of,
 * else the commands that own it (named `<key>_*`, or editors that declare it). ONE ready Next when the value carries
 * over (the corrected call, or the owning command whose only other required argument is the Story id); a long payload
 * is staged in a file (`@<file>`). Output flags and owner-lease meta options stay accepted; every other command keeps
 * the permissive parser (e.g. `validate`'s documented compatibility contract).
 */
import type { ZodType } from 'zod';
import { shellQuote } from '../core/shell-quote.js';
import { isReadOnlyCommand } from './activity-policy.js';

export const UNKNOWN_ARGUMENT = 'unknown_argument';

/** Commands whose dropped key is a lost edit: the Story-metadata editors. */
export const UNKNOWN_ARGUMENT_REFUSAL_COMMANDS: ReadonlySet<string> = new Set([
  'story_update', 'checklist_update', 'checklist_add', 'background_set', 'background_append', 'story_request_set',
]);
/** Accepted on every command: output selection and the owner-lease meta options (cli-engine CLI_META_SCHEMA). */
const TOLERATED_KEYS: ReadonlySet<string> = new Set(['json', 'format', 'brief', 'full', 'takeover', 'forceTakeover']);
/** A ready payload longer than this is staged in a file instead of printed inline. */
const INLINE_PAYLOAD_MAX = 1500;

interface ToolLike { name: string; description: string; schema: Record<string, ZodType> }
export interface UnknownArgumentRefusal { keys: string[]; text: string; next: string; json: Record<string, unknown> }

const snake = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Optimal string alignment distance (a transposition counts once). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The declared argument an undeclared key is a typo of (same letters ignoring case, or at most two edits away). */
function ownArgumentFor(key: string, declared: readonly string[]): string | null {
  const lower = key.toLowerCase();
  const exact = declared.find(name => name.toLowerCase() === lower);
  if (exact) return exact;
  if (key.length < 4) return null;
  const close = declared.map(name => ({ name, distance: editDistance(lower, name.toLowerCase()) })).filter(row => row.distance <= 2).sort((a, b) => a.distance - b.distance);
  return close.length && (close.length === 1 || close[0]!.distance < close[1]!.distance) ? close[0]!.name : null;
}

/** The commands that take the key: write commands named `<key>_*` first, then other metadata editors declaring it. */
function owningCommands(key: string, command: string, tools: readonly ToolLike[]): ToolLike[] {
  const prefix = `${snake(key)}_`;
  const named = tools.filter(tool => tool.name !== command && tool.name.startsWith(prefix) && !isReadOnlyCommand(tool.name) && !/_(?:get|list|status|show)$/.test(tool.name));
  const declaring = tools.filter(tool => tool.name !== command && UNKNOWN_ARGUMENT_REFUSAL_COMMANDS.has(tool.name) && key in tool.schema && !named.includes(tool));
  return [...named, ...declaring].slice(0, 3);
}

/** The one required argument besides storyId a command needs, when it has exactly one. */
function soleRequiredArgument(tool: ToolLike): string | null {
  const required = Object.entries(tool.schema).filter(([name, schema]) => name !== 'storyId' && !schema.isOptional()).map(([name]) => name);
  return required.length === 1 ? required[0]! : null;
}

/**
 * The refusal of a Story-metadata edit carrying keys its schema does not declare, or null (no such key, or a command
 * outside UNKNOWN_ARGUMENT_REFUSAL_COMMANDS). `stage(command, payload)` writes a long ready payload to a file and returns
 * its path (null: printed inline).
 */
export function unknownArgumentRefusal(args: { command: string; parsed: Record<string, unknown>; tools: readonly ToolLike[]; usageBin?: string;
  stage?: (command: string, payload: Record<string, unknown>) => string | null }): UnknownArgumentRefusal | null {
  const { command, parsed } = args;
  if (!UNKNOWN_ARGUMENT_REFUSAL_COMMANDS.has(command)) return null;
  const tool = args.tools.find(row => row.name === command);
  if (!tool) return null;
  const declared = Object.keys(tool.schema);
  const keys = Object.keys(parsed).filter(key => !(key in tool.schema) && !TOLERATED_KEYS.has(key));
  if (!keys.length) return null;
  const bin = args.usageBin ?? 'proof-or-stop';
  const render = (name: string, payload: Record<string, unknown>): string => {
    const json = JSON.stringify(payload);
    const staged = json.length > INLINE_PAYLOAD_MAX ? args.stage?.(name, payload) ?? null : null;
    return `${bin} ${name} ${staged ? `@${staged}` : shellQuote(json)}`;
  };
  const corrected: Record<string, unknown> = Object.fromEntries(Object.entries(parsed).filter(([key]) => !keys.includes(key) && !TOLERATED_KEYS.has(key)));
  const lines: string[] = [];
  const calls: string[] = [];
  const unknown: Array<{ key: string; argument: string | null; commands: string[] }> = [];
  let renamed = false;
  for (const key of keys) {
    const argument = ownArgumentFor(key, declared);
    if (argument) {
      lines.push(`  ${key}: not a ${command} argument; did you mean --${argument}?`);
      if (corrected[argument] === undefined) { corrected[argument] = parsed[key]; renamed = true; }
      unknown.push({ key, argument, commands: [] });
      continue;
    }
    const owners = owningCommands(key, command, args.tools);
    unknown.push({ key, argument: null, commands: owners.map(row => row.name) });
    lines.push(`  ${key}: not a ${command} argument (it takes ${declared.join(', ')}); ${owners.length
      ? `${owners.map(row => `${row.name} (${row.description.replace(/\s*\(.*$/, '')})`).join(' / ')} ${owners.length === 1 ? 'takes' : 'take'} it`
      : 'no editor takes it'}.`);
    const carrier = owners.find(row => soleRequiredArgument(row) && typeof parsed[key] === typeof '' && 'storyId' in row.schema);
    if (carrier && typeof parsed.storyId === 'string') calls.push(render(carrier.name, { storyId: parsed.storyId, [soleRequiredArgument(carrier)!]: parsed[key] }));
    else if (owners.length) calls.push(`${bin} ${owners[0]!.name} --help`);
  }
  // The call itself, without the refused keys, when it still edits something: first when a typo was corrected, else
  // after the owning command's call (the refused value is the edit the caller meant).
  const edits = Object.keys(corrected).filter(key => !['storyId', 'itemId', 'agent', 'actor', 'reason', 'intentBasis'].includes(key));
  if (renamed) calls.unshift(render(command, corrected));
  else if (edits.length) calls.push(render(command, corrected));
  if (!calls.length) calls.push(`${bin} ${command} --help`);
  const head = `${command} REFUSED, nothing was written: ${keys.length === 1 ? `it has no argument "${keys[0]}"` : `it has no arguments ${keys.map(key => `"${key}"`).join(', ')}`} `
    + `(an undeclared key used to be dropped and the edit reported as done) [${UNKNOWN_ARGUMENT}].`;
  const text = [head, ...lines, ...calls.map((call, index) => `${index === 0 ? 'Next' : 'And'}: ${call}`)].join('\n');
  return { keys, text, next: calls[0]!, json: { ok: false, reasonCode: UNKNOWN_ARGUMENT, recoverable: true, command, unknown, nextCommand: calls[0], commands: calls } };
}
