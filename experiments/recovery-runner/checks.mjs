// Deterministic scoring-checks layer for the §5 ablation / §6 recovery completion gate.
//
// Pre-registration: docs/requirements/decisions/lattice-experiment-protocol.md rev3.1
//   §2  — acceptance scripts are harness-owned, read-only, hash-checked per run, run from a
//         clean checkout, NOT visible in the agent-editable workspace (anti-gaming).
//   §4.1 — PRIMARY completion = acceptance exit 0 AND an independent hidden-regression +
//         diff-hygiene check passes (so the agent cannot game the visible acceptance script).
//   §7  — the run-record schema: acceptancePass, hiddenRegressionPass, diffHygienePass.
//
// PURE + DETERMINISTIC + OFFLINE. This module performs no top-level fs/process/network side
// effect on import. It makes no LLM call. The three checks are read-only SCORERS over the
// evidence they are handed (a harness-owned acceptance-script path + an injected runner, a
// baseline-vs-post failure snapshot, a changed-path list). harnessAcceptance() reads the
// acceptance script's bytes WHEN CALLED to hash them — that is the only fs touch and it is lazy
// (called inside the function so the module stays import-safe / side-effect-free). It NEVER
// performs the operation it scores; runAcceptance is injected so the selfcheck runs fully offline.
// (This source intentionally contains NO process-launch / network call tokens, so the selfcheck's
// offline source-guard finds zero matches.)
//
// FIELD NAMES: the three pass booleans use the EXACT §7 names — acceptancePass,
// hiddenRegressionPass, diffHygienePass (camelCase, no snake_case variant).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Static imports of node: builtins are load-time side-effect-free (no fs read, no network, no
// process launch happens merely by importing crypto/fs). The only fs touch is readFileSync called
// LAZILY inside harnessAcceptance when it actually hashes a harness-owned script.

// ---------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------

function toArray(v) {
  // Defensive coercion: null/undefined/non-array => empty list (never throws). A bare string is
  // treated as a single-element list so a caller may pass one path without wrapping.
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function asString(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

// Default acceptance runner. The module ships a NON-LAUNCHING placeholder so that importing or
// calling checks.mjs never starts a subprocess by itself — keeping it import-safe and the
// selfcheck fully offline. Live runner wiring (outside this story's scope) injects a real
// runAcceptance that runs the harness-owned script from a clean checkout and maps exit 0 ->
// {pass:true}. The placeholder is only reached if a caller hits the hashOk path WITHOUT injecting
// a runner, and it fails loud rather than silently passing.
function defaultRunAcceptance() {
  throw new Error(
    'harnessAcceptance: no runAcceptance injected — inject a runner that runs the harness-owned ' +
      'acceptance script (kept non-launching here so the module imports clean and stays offline)',
  );
}

// Default junk / forbidden artifact patterns for diff-hygiene (regex over the normalized path).
// These are flagged even when the path is technically under an allowed prefix — compiled output,
// secrets, logs, OS cruft, and dependency trees must never appear in an arm's diff.
export const DEFAULT_JUNK_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/, // .env and .env.* (concrete env / secret files)
  /(^|\/)node_modules(\/|$)/, // dependency tree
  /\.so$/, // shared objects
  /\.dll$/, // windows libs
  /\.dylib$/, // mac libs
  /\.wasm$/, // wasm blobs
  /\.pyc$/, // compiled python
  /\.o$/, // object files
  /\.a$/, // static archives
  /\.class$/, // compiled java
  /\.log$/, // logs
  /\.tmp$/, // temp files
  /\.swp$/, // vim swap
  /(^|\/)\.DS_Store$/, // mac finder cruft
];

function toRegExp(p) {
  if (p instanceof RegExp) {
    // STATELESS purity: a caller-supplied global/sticky RegExp keeps a mutable `lastIndex` that
    // `.test()` advances across calls, so the SAME input would alternate true/false and a "pure"
    // check would become stateful (and could MASK a violation). Strip g/y by reconstructing a
    // non-global equivalent so every `.test()` starts fresh. Non-global regexes are unchanged.
    if (p.global || p.sticky) return new RegExp(p.source, p.flags.replace(/[gy]/g, ''));
    return p;
  }
  // a plain string is treated as a directory/prefix allow entry (escaped literal). It matches a
  // path that is exactly the entry OR lives under it as a real path segment (entry + '/').
  const raw = asString(p).replace(/\/+$/, ''); // trim trailing slashes for prefix semantics
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // anchored prefix: ^entry($|/...) — so `src` allows `src` and `src/x.js` but NOT `src-evil/...`
  return new RegExp('^' + esc + '(?:/|$)');
}

// Normalize a changed path to a repo-root-relative POSIX path. Returns { norm, escapes } where
// `escapes` is true if the path traverses ABOVE the repo root (a `../` escape — a violation).
function normalizePath(p) {
  const s = asString(p).replace(/\\/g, '/'); // windows -> posix separators
  // Split and resolve `.`/`..` segments manually (no fs, deterministic, repo-root-relative).
  const parts = s.split('/');
  const stack = [];
  let escapes = false;
  for (const part of parts) {
    if (part === '' || part === '.') continue; // collapse empty + current-dir segments
    if (part === '..') {
      if (stack.length === 0) {
        escapes = true; // popping above the root => traversal escape
      } else {
        stack.pop();
      }
      continue;
    }
    stack.push(part);
  }
  return { norm: stack.join('/'), escapes };
}

// ---------------------------------------------------------------------------
// (1) harness-owned, hash-checked acceptance  (§2 anti-gaming + §4.1)
// ---------------------------------------------------------------------------

// harnessAcceptance({ acceptanceScriptPath, expectedHash, runAcceptance })
//   -> { acceptancePass, scriptHash, hashOk }
//
// ORDER MATTERS (anti-gaming, §2): compute the SHA-256 of the harness-owned script's bytes and
// compare to the frozen expectedHash FIRST. Only if hashOk is the injected runAcceptance() invoked
// to score acceptance. If the hash does not match (tampered / missing / wrong expectedHash), the
// script is NOT run and acceptancePass is false — so an agent-modified acceptance script is
// caught before it can run, and a self-overwriting script cannot retroactively pass.
//
// scriptHash is the empty string when the script could not be read (missing/unreadable path) — an
// empty expectedHash therefore never spuriously matches. runAcceptance is injected so the selfcheck
// (and any offline caller) need not start a subprocess; the default placeholder is non-launching.
export function harnessAcceptance({ acceptanceScriptPath, expectedHash, runAcceptance } = {}) {
  let scriptHash = '';
  try {
    // readFileSync runs ONLY here (lazily, on call) — the module body itself reads nothing at
    // import. A missing/unreadable script throws -> caught -> empty hash -> hashOk false below.
    const bytes = readFileSync(asString(acceptanceScriptPath));
    scriptHash = createHash('sha256').update(bytes).digest('hex');
  } catch {
    scriptHash = ''; // missing/unreadable script => empty hash => hashOk false below
  }

  // hashOk requires a non-empty expectedHash that exactly equals the computed hash. An empty
  // expectedHash (or an empty scriptHash from a missing file) can never be hashOk.
  const exp = asString(expectedHash);
  const hashOk = exp.length > 0 && scriptHash.length > 0 && scriptHash === exp;

  // Anti-gaming order: do NOT call runAcceptance unless hashOk.
  if (!hashOk) {
    return { acceptancePass: false, scriptHash, hashOk: false };
  }

  const run = typeof runAcceptance === 'function' ? runAcceptance : defaultRunAcceptance;
  const result = run();
  const acceptancePass = !!(result && result.pass === true);
  return { acceptancePass, scriptHash, hashOk: true };
}

// ---------------------------------------------------------------------------
// (2) hidden-regression  (§4.1 — no NEW failing tests vs the frozen baseline)
// ---------------------------------------------------------------------------

// hiddenRegression({ baselineFailures, postFailures }) -> { hiddenRegressionPass, newFailures }
//
// Failures are keyed by test IDENTITY (test id / name), NOT by error message: the SAME test name
// failing with a different message is the SAME pre-existing failure, not a new regression.
// newFailures = post-state failures whose id is NOT present in the baseline failure set.
// hiddenRegressionPass = (newFailures.length === 0) AND the baseline is present/valid.
// FAIL-SAFE: if baselineFailures is null/missing/corrupted (not an array of identifiable entries),
// hiddenRegressionPass is false — a corrupted baseline must never give a free pass.
export function hiddenRegression({ baselineFailures, postFailures } = {}) {
  // A valid baseline must be an array (it may be empty: "all tests passed before").
  if (!Array.isArray(baselineFailures)) {
    return { hiddenRegressionPass: false, newFailures: [] };
  }

  const baselineIds = new Set();
  for (const f of baselineFailures) {
    const id = failureId(f);
    if (id !== '') baselineIds.add(id);
  }

  const post = toArray(postFailures);
  const seen = new Set();
  const newFailures = [];
  for (const f of post) {
    const id = failureId(f);
    if (id === '') continue; // unidentifiable post entry: cannot key it; skip (not counted new)
    if (baselineIds.has(id)) continue; // pre-existing failure (any error message) => not new
    if (seen.has(id)) continue; // de-dupe a repeated new id
    seen.add(id);
    newFailures.push(id);
  }

  const hiddenRegressionPass = newFailures.length === 0;
  return { hiddenRegressionPass, newFailures };
}

// failureId: extract a test's stable identity from a failure entry. Accepts a string (the id) or
// an object with id|name|test|testId|fullName. Returns '' if no identity can be derived. The error
// message (message|error|err) is DELIBERATELY ignored for identity.
function failureId(f) {
  if (f == null) return '';
  if (typeof f === 'string') return f;
  if (typeof f === 'object') {
    for (const k of ['id', 'name', 'test', 'testId', 'fullName']) {
      if (typeof f[k] === 'string' && f[k].length > 0) return f[k];
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// (3) diff-hygiene  (§4.1 / §8 threats — change confined to allowed paths, no junk)
// ---------------------------------------------------------------------------

// diffHygiene({ changedPaths, allowedPaths, junkPatterns }) -> { diffHygienePass, violations }
//
// Each changed path is normalized (POSIX, `.`/`..` resolved). A `../` traversal that escapes the
// repo root is a violation. diffHygienePass = every changed path is WITHIN allowedPaths AND
// matches NO junk/forbidden pattern. Junk (default: .env, node_modules/, *.so, *.log, *.tmp,
// *.swp, .DS_Store, …) is flagged EVEN IF under an allowed path. violations is a list of
// {path, reason} (path is the original input string).
//
// allowedPaths semantics: a string entry is a directory/prefix (anchored, real-segment match, so
// `src` allows `src/x.js` but NOT `src-evil/...`); a RegExp entry is used as-is (g/y stripped for
// purity). An EMPTY allowedPaths means nothing is allowed => any change is a violation.
export function diffHygiene({ changedPaths, allowedPaths, junkPatterns } = {}) {
  const paths = toArray(changedPaths).map(asString).filter((p) => p.length > 0);
  const allowed = toArray(allowedPaths).map(toRegExp);
  const junk = (junkPatterns != null ? toArray(junkPatterns) : DEFAULT_JUNK_PATTERNS).map(toRegExp);

  const violations = [];
  for (const orig of paths) {
    const { norm, escapes } = normalizePath(orig);
    if (escapes) {
      violations.push({ path: orig, reason: 'path-traversal-escape' });
      continue; // an escaped path is not meaningfully checkable against the allow-list
    }
    // junk/forbidden artifact — flagged even when under an allowed path.
    if (junk.some((re) => re.test(norm))) {
      violations.push({ path: orig, reason: 'junk-artifact' });
      continue;
    }
    // outside the allow-list (also covers empty allowedPaths => everything is out-of-scope).
    if (!allowed.some((re) => re.test(norm))) {
      violations.push({ path: orig, reason: 'out-of-scope' });
    }
  }

  const diffHygienePass = violations.length === 0;
  return { diffHygienePass, violations };
}

// ---------------------------------------------------------------------------
// §7 field-name / checklist-name aliases
// ---------------------------------------------------------------------------
// The pre-reg §7 schema names the pass booleans acceptancePass / hiddenRegressionPass /
// diffHygienePass (the keys returned above). The story checklist refers to the functions as
// checkAcceptance / checkHiddenRegression / checkDiffHygiene; export those as aliases so both the
// schema field names and the checklist call-sites resolve to the same pure implementation.
export const checkAcceptance = harnessAcceptance;
export const checkHiddenRegression = hiddenRegression;
export const checkDiffHygiene = diffHygiene;
