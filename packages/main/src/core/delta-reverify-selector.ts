/**
 * Lab run132 (old-PoS run 135 item H; bench-staging/oldpos/run135-analysis.md; switch `review.deltaSelectorRepair`,
 * default on, `off` = rollback). Run 135 R2: the delta confirmation lane wrote
 * `[reverified] F-001 :: go test -v ./evaluator -run TestTwoPartRangeNullEndCompatibility/array_explicit_null_end -count=1 :: PASS`
 * for each of four resolved findings. The generic selector "PASS" was refused (core/review-delta-round.ts
 * checkDeltaConfirmationNote) and the round went straight to a full round (~10 min, ~12M tokens), though each
 * command named its test and the lane's own recorded output showed it passing.
 *
 * A generic selector is filled, never trusted:
 *   command          the command names exactly one test (Go `-run <Name>` / `-run=^<Name>$`, a `/`-separated subtest
 *                    path allowed; pytest `<file>::<test>`): the selector is the line that runner prints for it
 *                    (`--- PASS: <Name>`, `<file>::<test> PASSED`);
 *   correction       otherwise it is asked for once in the lane's own resumed session before the run seals
 *                    (core/managed-host-run.ts `delta_reverify_selector_correction`, answer only);
 *   rerun_output     a selector still generic at import is taken from the framework's OWN re-run of that command
 *                    (in process, core/review-delta-confirmation.ts): exit 0 and exactly one top-level test-named pass
 *                    line. Nothing is read from a runtime file (the lane's live output is owner-writable).
 * The framework's re-run still requires exit 0 and that line, so a fill never passes what does not pass; anything
 * else is refused and the round escalates to a full round exactly as before.
 *
 * Leaf module (no imports): the managed worker imports it.
 */

/** A selector that names nothing (the same rule the refusal applies). */
export const GENERIC_REVERIFY_SELECTOR = /^(?:ok|pass(?:ed)?|--- ?pass:?|pass:?|success|done|\d+ passing)$/i;

export function isGenericReverifySelector(selector: string): boolean {
  const trimmed = selector.trim();
  return trimmed.length < 6 || GENERIC_REVERIFY_SELECTOR.test(trimmed);
}

/** Shell-like words of a command (single / double quotes, backslash escapes); no expansion. */
export function commandWords(command: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) { word += command[index + 1]; index += 1; }
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\' && index + 1 < command.length) { word += command[index + 1]; index += 1; started = true; continue; }
    if (/\s/.test(char)) { if (started) out.push(word); word = ''; started = false; continue; }
    word += char; started = true;
  }
  if (started) out.push(word);
  return out;
}

/** The words of a command without a `bash -c` / `sh -lc` wrapper (its script re-split). */
export function unwrappedCommandWords(command: string): string[] {
  const words = commandWords(command);
  const shell = words[0]?.replace(/^.*\//, '');
  if ((shell === 'bash' || shell === 'sh' || shell === 'zsh') && /^-l?c$|^-lc$|^-c$/.test(words[1] ?? '') && words[2] !== undefined) return commandWords(words[2]);
  return words;
}

/** A comparable form of a command: unwrapped words joined by one space. */
export function normalizedCommand(command: string): string {
  return unwrappedCommandWords(command).join(' ');
}

const GO_TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z0-9_.+=:,-]+)*$/;
const PY_TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\s]+\])?$/;

/** The one test a command names and the line its runner prints when it passes, or null. */
export function commandNamedTest(command: string): { runner: 'go' | 'pytest'; name: string; passLine: string } | null {
  const words = unwrappedCommandWords(command);
  const exe = words[0]?.replace(/^.*\//, '');
  if (exe === 'go' && words[1] === 'test') {
    let pattern: string | null = null;
    for (let index = 2; index < words.length; index += 1) {
      const word = words[index]!;
      if (word === '-run' || word === '--run') pattern = words[index + 1] ?? null;
      else if (/^--?run=/.test(word)) pattern = word.replace(/^--?run=/, '');
    }
    if (!pattern) return null;
    const name = pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\$\//g, '/').replace(/\/\^/g, '/');
    if (!GO_TEST_NAME.test(name)) return null;
    return { runner: 'go', name, passLine: `--- PASS: ${name}` };
  }
  const pytest = exe === 'pytest' || exe === 'py.test' || ((exe === 'python' || exe === 'python3') && words[1] === '-m' && words[2] === 'pytest');
  if (pytest) {
    const targets = words.filter(word => word.includes('::'));
    if (targets.length !== 1) return null;
    const test = targets[0]!.split('::').at(-1)!;
    if (!PY_TEST_NAME.test(test)) return null;
    return { runner: 'pytest', name: targets[0]!, passLine: `${targets[0]} PASSED` };
  }
  return null;
}

/** Top-level test-named pass lines of one output (Go `--- PASS: X`, pytest `path::test PASSED`). */
function topLevelPassLines(output: string): string[] {
  const out = new Set<string>();
  for (const line of String(output).split('\n')) {
    const go = line.match(/^--- PASS: (\S+)/);
    if (go) { out.add(`--- PASS: ${go[1]}`); continue; }
    const py = line.match(/^(\S+::\S+) PASSED\b/);
    if (py) out.add(`${py[1]} PASSED`);
  }
  return [...out];
}

/** The filled selector of a `[reverified]` line whose selector is generic, from the test its command names, or null. */
export function fillReverifySelector(args: { command: string }): { selector: string; source: 'command' } | null {
  const named = commandNamedTest(args.command);
  return named ? { selector: named.passLine, source: 'command' } : null;
}

/**
 * The selector of a generic `[reverified]` line whose command names no single test, from the framework's OWN re-run
 * output (in process; never a runtime file the owner could write): its one top-level test-named pass line, else null.
 */
export function rerunPassSelector(output: string): string | null {
  const lines = topLevelPassLines(output);
  return lines.length === 1 ? lines[0]! : null;
}

/** The one-turn correction prompt of a confirmation lane's generic `[reverified]` selectors (answer only). */
export function deltaReverifySelectorPrompt(rows: ReadonlyArray<{ findingId: string; command: string; selector: string }>, schemaVersion: string): string {
  return [
    'Framework check of your final JSON: your [reverified] line(s) below end in a generic selector, which the framework refuses (it re-runs the command and needs the exact test-named line it prints):',
    ...rows.map(row => `- [reverified] ${row.findingId} :: ${row.command} :: ${row.selector}`),
    'Replace each selector with the exact test-named line that command printed when you ran it, e.g. `--- PASS: <TestName>` (Go -v) or `<file>::<test> PASSED` (pytest -v); name the finding\'s own test.',
    'Do not run any more commands and do not change your verdict, findings, read manifest or any other line.',
    `Emit, as your final message, only your complete final JSON object (schemaVersion "${schemaVersion}") with those lines corrected. Output no other text and no Markdown fence.`,
  ].join('\n');
}
