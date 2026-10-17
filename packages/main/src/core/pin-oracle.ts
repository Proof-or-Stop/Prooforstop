/**
 * Old-PoS run 31 pin oracle: a mechanical check of pinned input -> output
 * examples against the project's own evaluator at the Story base.
 *
 * Run 31's owner hand-computed pinned values wrong three times (two string
 * write edges, then a non-ASCII example pinned with one wrong character), each one
 * costing a reviewer round or a DEV -> PLAN round trip. A value the project can
 * compute itself must not depend on the owner's arithmetic.
 *
 * Oracle (sound by construction): the command the project declares in
 * proof-or-stop.config.json `pinOracle` (read from the Story base commit, a
 * frozen control asset), run inside a `git archive` of the Story base commit
 * under `.proof-or-stop/runtime/pin-oracle/<base12>/tree`. Only the project's
 * own code at the base runs: never the Story's change (circular), never a
 * hidden test, never a task-specific answer table.
 *
 *   "pinOracle": {
 *     "command": "go", "args": ["run", ".", "{file}"],   // {file} = the program file, {tree} = the base tree
 *     "program": "echo({input})",                         // {input} = the example input
 *     "extension": ".abs",
 *     "setup": { "command": "go", "args": ["build", "-o", ".pos-oracle", "."] },  // optional, once per base
 *     "skipPattern": "ERROR|parse error",                 // optional: output that means "base cannot run it"
 *     "timeoutMs": 30000
 *   }
 *
 * Which rows: a verificationIntent row whose desc is `<input> -> <value>` (or
 * `==` / `=>` / `→`), the input the code-like token right before the
 * separator, the value a concrete literal right after it (a quoted string, a
 * bracket group or a number). Assignments, bare literals (`... over "hello"
 * -> "Hello"`) and prose do not evaluate.
 *
 * Outcomes per row:
 *   - the base cannot evaluate the input (non-zero exit, empty output, the
 *     skipPattern, a timeout): skipped silently. New syntax lands here: the base
 *     is no oracle for what it cannot parse, and no generic oracle is (a
 *     language-semantics oracle declared for the task would be a task-specific
 *     answer). The scope-plan reviewer's pin audit gets the oracle command to
 *     evaluate the sub-expressions the base supports (renderPinOracleAudit).
 *   - the base computes the pinned value: consistent.
 *   - the base reports a parse error OUTSIDE the declared new syntax
 *     (`parseErrorPattern` + `newSyntaxPattern`, old-PoS run 32): the example
 *     itself is malformed; reported as a mismatch (baseValue cannot excuse it).
 *   - the base computes another value: a blocker ([pin_oracle_mismatch]) with
 *     the computed value, unless the row records that base value in
 *     `baseValue` (the Story deliberately changes this base behaviour). The pin
 *     is never rewritten by the framework.
 *
 * Values compare after trimming and stripping one pair of surrounding quotes
 * ('' or "") on both sides, whitespace inside bracket groups aside.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem, VerificationIntent, VerificationLane } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const PIN_ORACLE_MISMATCH = 'pin_oracle_mismatch';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Inputs evaluated per check (cached results do not count). */
const MAX_EVALUATIONS = 40;

export interface PinOracleConfig {
  command: string;
  args?: string[];
  program?: string;
  extension?: string;
  setup?: { command: string; args?: string[] };
  skipPattern?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Old-PoS run 32 (optional, with newSyntaxPattern): a regex matching the
   * runner's parse-error output, named groups `line` (1-based, default 1) and
   * `col` (1-based) giving the FIRST error's position in the program file.
   */
  parseErrorPattern?: string;
  /**
   * Regex of the request's new syntax (e.g. the new operator's token),
   * matched per program line: a base parse error inside a match (+-1 column)
   * is expected; one outside every match is an authoring error.
   */
  newSyntaxPattern?: string;
}

export interface PinExample { ref: string; lane: VerificationLane; index: number; input: string; pinned: string; baseValue?: string }
export interface PinMismatch extends PinExample { computed: string }
export interface PinOracleContext { config: PinOracleConfig; base: string; tree: string; env: Record<string, string> }

const SEPARATOR = /\s*(?:->|→|=>|==)\s*/;
const OPERATOR_TAIL = /[-+*/%<>=!&|,(]$/;

/** The trailing code-like token of `text`: no whitespace outside quotes / brackets. */
function trailingToken(text: string): string | null {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  if (trimmed.endsWith('`')) {
    const open = trimmed.lastIndexOf('`', trimmed.length - 2);
    return open >= 0 ? trimmed.slice(open + 1, -1).trim() || null : null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index]!;
    if (quote) { if (char === quote && trimmed[index - 1] !== '\\') quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ')' || char === ']' || char === '}') depth += 1;
    else if (char === '(' || char === '[' || char === '{') depth -= 1;
    if (depth < 0) return null;
    if (depth === 0 && /\s/.test(char)) {
      // The expression continues leftward (`1 + 1`): not a standalone input.
      if (OPERATOR_TAIL.test(trimmed.slice(0, index).trimEnd())) return null;
      return trimmed.slice(index + 1) || null;
    }
  }
  return quote || depth !== 0 ? null : trimmed;
}

/** The leading concrete value of `text`: a quoted string, a bracket group or a number. */
function leadingValue(text: string): string | null {
  const trimmed = text.trimStart().replace(/^`([^`]+)`.*$/s, '$1');
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === first && trimmed[index - 1] !== '\\') return trimmed.slice(0, index + 1);
    }
    return null;
  }
  if (first === '[' || first === '{') {
    const close = first === '[' ? ']' : '}';
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (quote) { if (char === quote && trimmed[index - 1] !== '\\') quote = null; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === first) depth += 1;
      else if (char === close && --depth === 0) return trimmed.slice(0, index + 1);
    }
    return null;
  }
  const number = trimmed.match(/^-?\d+(?:\.\d+)?(?![\w.])/);
  return number ? number[0] : null;
}

/** An executable input -> value example of one intent desc, or null. */
export function pinExampleOf(desc: string): { input: string; pinned: string } | null {
  const match = desc.match(SEPARATOR);
  if (!match || match.index === undefined) return null;
  const input = trailingToken(desc.slice(0, match.index));
  const pinned = leadingValue(desc.slice(match.index + match[0].length));
  if (!input || !pinned) return null;
  // A bare literal is no computation: `s[0]="H" over "hello" -> "Hello"` names
  // its subject in prose, and evaluating "hello" would "compute" hello.
  if (leadingValue(input) === input) return null;
  // An assignment (`s[0]="H"`) needs context the oracle does not have.
  if (/(?<![=!<>])=(?!=)/.test(input.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''))) return null;
  return { input, pinned };
}

export function pinExamples(itemId: string, intent: VerificationIntent | undefined): PinExample[] {
  if (!intent) return [];
  const rows: PinExample[] = [];
  for (const lane of VERIFICATION_LANES) {
    for (const [index, row] of (intent[lane] ?? []).entries()) {
      const example = pinExampleOf(String(row.desc ?? ''));
      if (!example) continue;
      rows.push({ ref: row.id ?? `${itemId}:${lane}:${index}`, lane, index, ...example,
        ...(typeof row.baseValue === 'string' ? { baseValue: row.baseValue } : {}) });
    }
  }
  return rows;
}

/** Comparison form of a value: trimmed, one pair of surrounding quotes off, whitespace in groups aside. */
export function normalizePinValue(value: string): string {
  let text = value.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) text = text.slice(1, -1);
  else if (/^[[{]/.test(text)) text = text.replace(/\s+/g, '');
  return text;
}

const compiled = (source: string | undefined, flags: string): RegExp | null => {
  if (!source) return null;
  try { return new RegExp(source, flags); } catch { return null; }
};

/**
 * Old-PoS run 32 (3c): the first parse error of `output` when it lies OUTSIDE
 * every new-syntax region of `program` (the error line, for the owner), else
 * null: no declaration, no parse error, or an error inside the new syntax
 * (the base merely lacks it). Generic: the project declares both patterns.
 */
export function parseErrorOutsideNewSyntax(config: Pick<PinOracleConfig, 'parseErrorPattern' | 'newSyntaxPattern'>, program: string, output: string): string | null {
  const parse = compiled(config.parseErrorPattern, '');
  const syntax = compiled(config.newSyntaxPattern, 'g');
  if (!parse || !syntax) return null;
  const match = parse.exec(output);
  if (!match) return null;
  const col = Number(match.groups?.col);
  const line = Number(match.groups?.line ?? 1);
  if (!Number.isInteger(col) || !Number.isInteger(line) || line < 1) return null;
  const text = program.split('\n')[line - 1] ?? '';
  for (const region of text.matchAll(syntax)) {
    const start = (region.index ?? 0) + 1;
    if (col >= start - 1 && col <= start + region[0].length) return null;
  }
  const detail = output.slice(match.index).split('\n').map(part => part.trim()).filter(Boolean).slice(0, 3).join(' ');
  return `${detail.slice(0, 200)} (line ${line} column ${col}: \`${text.trim().slice(0, 120)}\`)`;
}

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim(); } catch { return null; }
}

/** A runner declaration (command + optional string args), or null. */
export function validRunnerConfig(raw: unknown): PinOracleConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const config = raw as Record<string, unknown>;
  if (typeof config.command !== 'string' || !config.command.trim()) return null;
  if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every(arg => typeof arg === 'string'))) return null;
  return config as unknown as PinOracleConfig;
}

/** The pinOracle (and validate.env) declared in proof-or-stop.config.json at the base commit, or null. */
export function readBasePinOracle(gitCwd: string, base: string): { config: PinOracleConfig; env: Record<string, string> } | null {
  const text = git(gitCwd, ['show', `${base}:proof-or-stop.config.json`]);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { pinOracle?: unknown; validate?: { env?: Record<string, string> } };
    const config = validRunnerConfig(parsed.pinOracle);
    return config ? { config, env: { ...(parsed.validate?.env ?? {}), ...(config.env ?? {}) } } : null;
  } catch { return null; }
}

/** The Story base: the frozen integration base when recorded, else the merge-base with main/master. */
export function pinOracleStoryBase(gitCwd: string, frozenBase: string | null | undefined): string | null {
  if (frozenBase && /^[0-9a-f]{40}$/.test(frozenBase) && git(gitCwd, ['cat-file', '-e', `${frozenBase}^{commit}`]) !== null) return frozenBase;
  for (const branch of ['main', 'master']) {
    const base = git(gitCwd, ['merge-base', 'HEAD', branch]);
    if (base && /^[0-9a-f]{40}$/.test(base)) return base;
  }
  return null;
}

/**
 * A `git archive` of `commit` under `dir/tree` with `setup` run in it, created
 * once (atomic rename; `dir/ready.json` marks it), or null when the archive or
 * the setup fails. Shared with the framework probe runner (core/request-probes.ts).
 */
/** Credential-looking environment names / URL values (probe runner and setup are never given them). */
const PROBE_ENV_SECRET = /(TOKEN|KEY|SECRET|PASSW|CREDENTIAL|PROXY|AUTH|COOKIE|SESSION)|^(OPENCODE|OPENAI|ANTHROPIC|GH_|GITHUB_|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD|NPM_CONFIG_|SSH_|GPG_)/i;
const URL_USERINFO = /:\/\/[^/\s@]*@/;
export const isProbeEnvSecret = (name: string, value = ''): boolean => PROBE_ENV_SECRET.test(name) || URL_USERINFO.test(value);

/** Setup (project-declared command from the base commit, may need the network): parent env minus credential-looking entries. */
const setupEnv = (declared: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...declared })) if (v !== undefined && !isProbeEnvSecret(k.replace(/proxy/gi, ''), v)) out[k] = v;
  return out;
};

export function prepareArchivedTree(dir: string, gitCwd: string, commit: string, setup: PinOracleConfig['setup'], timeoutMs: number | undefined, env: Record<string, string>): string | null {
  const tree = join(dir, 'tree');
  const ready = join(dir, 'ready.json');
  if (existsSync(ready)) return tree;
  mkdirSync(dir, { recursive: true });
  const staging = mkdtempSync(join(dir, 'staging-'));
  try {
    const archive = join(staging, 'base.tar');
    if (git(gitCwd, ['archive', '--format=tar', '-o', archive, commit]) === null) return null;
    const extracted = join(staging, 'tree');
    mkdirSync(extracted);
    if (spawnSync('tar', ['-xf', archive, '-C', extracted], { stdio: 'ignore' }).status !== 0) return null;
    rmSync(archive, { force: true });
    if (setup?.command) {
      const ran = spawnSync(setup.command, setup.args ?? [], { cwd: extracted, env: setupEnv(env), encoding: 'utf8',
        timeout: Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000), stdio: ['ignore', 'pipe', 'pipe'] });
      if (ran.status !== 0) return null;
    }
    if (existsSync(tree)) rmSync(staging, { recursive: true, force: true });
    else renameSync(extracted, tree);
    writeFileSync(ready, `${JSON.stringify({ commit, preparedAt: new Date().toISOString() })}\n`);
    return tree;
  } catch {
    // A concurrent preparation of the same commit may have won the rename.
    return existsSync(ready) ? tree : null;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The base tree with the oracle's setup done, created once per base commit
 * (atomic rename), or null when the project declares no oracle or setup fails.
 */
export function preparePinOracle(runtimeRoot: string, gitCwd: string, base: string): PinOracleContext | null {
  const declared = readBasePinOracle(gitCwd, base);
  if (!declared) return null;
  const dir = join(runtimeRoot, PROOF_OR_STOP_DIR, 'runtime', 'pin-oracle', base.slice(0, 12));
  const tree = prepareArchivedTree(dir, gitCwd, base, declared.config.setup, declared.config.timeoutMs, declared.env);
  return tree ? { config: declared.config, base, tree, env: declared.env } : null;
}

type OracleResult = { status: 'value'; value: string } | { status: 'unsupported' } | { status: 'syntax'; error: string };

/** Evaluate inputs with the oracle (cached per base + program text). */
export function evaluatePinOracle(oracle: PinOracleContext, inputs: readonly string[]): Map<string, OracleResult> {
  const dir = join(oracle.tree, '..');
  const cachePath = join(dir, 'results.json');
  let cache: Record<string, OracleResult> = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, OracleResult>; } catch { cache = {}; }
  const out = new Map<string, OracleResult>();
  const programs = join(dir, 'programs');
  mkdirSync(programs, { recursive: true });
  let evaluated = 0;
  let dirty = false;
  const skip = oracle.config.skipPattern ? (() => { try { return new RegExp(oracle.config.skipPattern!); } catch { return null; } })() : null;
  for (const input of new Set(inputs)) {
    const program = (oracle.config.program ?? '{input}').split('{input}').join(input);
    const key = createHash('sha256').update(JSON.stringify([oracle.config, program])).digest('hex');
    if (cache[key]) { out.set(input, cache[key]!); continue; }
    if (evaluated >= MAX_EVALUATIONS) continue;
    evaluated += 1;
    const file = join(programs, `${key.slice(0, 16)}${oracle.config.extension ?? '.txt'}`);
    writeFileSync(file, `${program}\n`);
    const fill = (text: string) => text.split('{file}').join(file).split('{tree}').join(oracle.tree);
    const ran = spawnSync(fill(oracle.config.command), (oracle.config.args ?? ['{file}']).map(fill), {
      cwd: oracle.tree, env: { ...process.env, ...oracle.env }, encoding: 'utf8', timeout: oracle.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const stdout = (ran.stdout ?? '').trim();
    // Old-PoS run 32: a parse error outside the declared new syntax is the row's own
    // syntax error (reported), not "the base cannot run new syntax" (skipped).
    const syntaxError = !ran.error && ran.status !== 0 ? parseErrorOutsideNewSyntax(oracle.config, program, `${stdout}\n${(ran.stderr ?? '').trim()}`) : null;
    const result: OracleResult = syntaxError ? { status: 'syntax', error: syntaxError }
      : ran.status === 0 && !ran.error && stdout && !(skip && (skip.test(stdout) || skip.test(ran.stderr ?? '')))
        ? { status: 'value', value: stdout } : { status: 'unsupported' };
    // A timeout may be load, not the input: never cache it.
    if (!ran.error) { cache[key] = result; dirty = true; }
    out.set(input, result);
  }
  if (dirty) {
    try { writeFileSync(cachePath, `${JSON.stringify(cache)}\n`); } catch { /* the cache is an optimisation */ }
  }
  return out;
}

/** The rows of `items` whose base value differs from the pin and that record no matching baseValue. */
export function pinOracleMismatches(oracle: PinOracleContext, items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>>): Array<{ itemId: string; rows: PinMismatch[] }> {
  const byItem = items.filter(item => item.status !== 'withdrawn').map(item => ({ itemId: item.id, examples: pinExamples(item.id, item.verificationIntent) }))
    .filter(entry => entry.examples.length > 0);
  if (!byItem.length) return [];
  const results = evaluatePinOracle(oracle, byItem.flatMap(entry => entry.examples.map(row => row.input)));
  return byItem.map(entry => ({ itemId: entry.itemId, rows: entry.examples.flatMap(row => {
    const result = results.get(row.input);
    if (result?.status === 'syntax') return [{ ...row, computed: `parse error outside the new syntax: ${result.error}` }];
    if (!result || result.status !== 'value') return [];
    const computed = normalizePinValue(result.value);
    if (computed === normalizePinValue(row.pinned)) return [];
    if (row.baseValue !== undefined && normalizePinValue(row.baseValue) === computed) return [];
    return [{ ...row, computed: result.value }];
  }) })).filter(entry => entry.rows.length > 0);
}

export function describePinMismatch(row: PinMismatch): string {
  const shown = row.computed.length > 200 ? `${row.computed.slice(0, 199)}…` : row.computed;
  return `${row.ref}: ${row.input} -> the Story base computes ${shown}, the row pins ${row.pinned}`
    + (row.baseValue !== undefined ? ` (its baseValue ${JSON.stringify(row.baseValue)} is not the base value)` : '');
}

/** What the owner does about a mismatch (refusal and next step). */
export function pinMismatchRule(oracle: PinOracleContext): string {
  return `The project's pin oracle (${[oracle.config.command, ...(oracle.config.args ?? [])].join(' ')}, Story base ${oracle.base.slice(0, 12)}) evaluated the input. `
    + 'If the pin is wrong, correct the row\'s expected value (and its derivation). If the Story deliberately changes this base behaviour, keep the pin and record the base value on the row as "baseValue":"<computed value>" (the scope-plan reviewer audits it against the request). The framework never rewrites the pin.';
}

/** The refusal text for checklist_update, or null. */
export function pinOracleRefusal(command: string, storyId: string, itemId: string, oracle: PinOracleContext, rows: readonly PinMismatch[]): string | null {
  if (!rows.length) return null;
  return `${command} REFUSED, nothing was written: a pinned example differs from what the project computes at the Story base [${PIN_ORACLE_MISMATCH}]\n`
    + `${rows.map(describePinMismatch).join('\n')}\n${pinMismatchRule(oracle)}\n`
    + `Next: proof-or-stop checklist_update '${JSON.stringify({ storyId, itemId, verificationIntent: '<the complete verificationIntent with each listed row corrected, or with "baseValue" set to the computed base value>' })}'`;
}

/** Scope-plan reviewer pin-audit line: the oracle the reviewer runs for what the framework could not evaluate. */
export function renderPinOracleAudit(oracle: PinOracleContext | null): string[] {
  if (!oracle) return [];
  const argv = [oracle.config.command, ...(oracle.config.args ?? ['{file}'])].join(' ').split('{tree}').join(oracle.tree);
  return [`Pin oracle (project-declared, Story base ${oracle.base.slice(0, 12)}): write a program file (e.g. under /tmp) containing \`${oracle.config.program ?? '{input}'}\` with {input} replaced, then run \`${argv}\` from ${oracle.tree} with {file} replaced by its path (env ${JSON.stringify(oracle.env)}). The framework already checked every example whose input the base evaluates; for an example the base cannot run (new syntax), evaluate the sub-expressions it can run and derive the rest by hand from those results. A pinned value that disagrees is a \`pin-audit <ref>\` gap; a row's "baseValue" claims the Story changes that base behaviour: a gap unless the request says so.`];
}

/** The prepared oracle of a Story (its base commit's declaration), or null. */
export function storyPinOracle(store: { readStory(storyId: string): unknown }, root: string, storyId: string, gitCwd: string): PinOracleContext | null {
  try {
    // Cheap pre-gate without git: a project that declares no oracle in its current
    // config pays nothing (the declaration that counts is still the base commit's).
    if (!existsSync(join(gitCwd, 'proof-or-stop.config.json')) || !readFileSync(join(gitCwd, 'proof-or-stop.config.json'), 'utf8').includes('"pinOracle"')) return null;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(gitCwd, story.integrationTarget?.parentCommitAtCreation);
    return base ? preparePinOracle(resolveCanonicalRuntimeProjectRoot(root), gitCwd, base) : null;
  } catch {
    return null;
  }
}
