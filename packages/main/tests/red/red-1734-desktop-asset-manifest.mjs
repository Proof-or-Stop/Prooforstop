#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 D1 and B-bcae F-008/F-017 — the packaged desktop binary must ship EVERY
 * first-party module bin/bootstrap-runner.js reaches on the startup path, plus the exact third-party
 * closure those modules need at runtime, or a packaged desktop runtime dies before it can run anything.
 *
 * bin/bootstrap-runner.js is the desktop pkg entrypoint (scripts/package-desktop.mjs's pkg-entry copies
 * the asset-manifest files into a runtime root and imports it from there). Two distinct regressions have
 * shipped through this seam:
 *
 *   B-1734 D1 — bootstrap STATICALLY imports scripts/build-lock-target.mjs. That lives under scripts/,
 *     not packages/<pkg>/dist, so no listFiles() spread ships it; the pre-fix manifest omitted it and the
 *     packaged runtime threw ERR_MODULE_NOT_FOUND at module-init.
 *   B-bcae F-008/F-017 — bootstrap also reaches scripts/build-lock.mjs DYNAMICALLY (reader admission,
 *     taken on the success path once dist is present, which in a packaged runtime is ALWAYS). The manifest
 *     shipped neither that helper nor proper-lockfile's runtime closure, so every packaged invocation
 *     exited 1 with the local-bootstrap-is-not-ready text. The previous version of this file matched only
 *     static top-level `import … from` statements, so a computed dynamic specifier was invisible to it and
 *     its drift-proof claim did not cover the real bootstrap dependency set.
 *
 * What this file now binds, mechanically:
 *
 *   manifest:0 — the DERIVED asset manifest (the real writeAssetManifest file list, evaluated from
 *                scripts/package-desktop.mjs source without running packaging) ships every scripts/ module
 *                in bootstrap's transitive STATIC import graph.
 *   manifest:1 — EVERY dynamic `import(...)` site in bootstrap is classified into a known shape. An
 *                unrecognised shape fails the test rather than being skipped, so a new computed dynamic
 *                import cannot slip past the derivation below.
 *   manifest:2 — every first-party module reached by those dynamic imports (and the transitive static
 *                graph of each first-party SOURCE module among them) is shipped by the derived manifest.
 *   manifest:3 — the transitive third-party closure of that first-party set, resolved the way Node
 *                actually resolves it from each importer, is shipped. This is what pins the signal-exit
 *                copy NESTED under node_modules/proper-lockfile rather than the unrelated hoisted root one.
 *   manifest:4 — a bounded packaged-runtime startup witness: a runtime root materialised from EXACTLY the
 *                derived manifest starts through bootstrap and answers --version with exit 0.
 *   manifest:5 — control cases proving manifest:4 is not vacuous: deleting scripts/build-lock.mjs or the
 *                proper-lockfile package from that same runtime root each makes startup fail, and so does
 *                REPLACING the nested signal-exit copy with the hoisted root one. The third is a
 *                substitution, not a removal, and that is what makes it the direct proof that the hoisted
 *                root copy does not satisfy the requirement: a plain deletion would leave the runtime with
 *                no signal-exit at all and prove only that some copy is needed.
 *
 * SCOPE, stated honestly. This is not a pkg-binary test: it exercises the asset manifest and the runtime
 * root pkg-entry builds from it, not pkg's snapshot embedding. Graph walking is bounded to first-party
 * SOURCE modules (bin/, scripts/); compiled packages/<pkg>/dist entries are checked for manifest
 * membership but their own import graphs are not traversed, because dist's dependencies are a build-output
 * concern already covered by the wholesale listFiles() spreads. The no-dist / no-node_modules recovery
 * behaviour is owned by red-1734-bootstrap-depfree.mjs and is deliberately not duplicated here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const BOOTSTRAP_REL = 'bin/bootstrap-runner.js';
const BOOTSTRAP_ABS = join(repoRoot, BOOTSTRAP_REL);
const PACKAGE_DESKTOP_REL = 'scripts/package-desktop.mjs';

// ── the aggregate startup budget (B-bcae F-047) ───────────────────────────────────────────────────────
// This file boots the packaged runtime FIVE times: the manifest:4 witness, the three manifest:5 controls
// and the restored run. A per-spawn cap therefore bounds ONE boot, never the file — five 60s caps admit
// 300s against a registered budget of 180s, and in exactly the case a cap exists for (a hanging boot) the
// outer validator would kill the harness before it could print its own diagnostic. So the bound here is an
// AGGREGATE deadline: read the budget the validator actually registered for this file, subtract a reserve
// for teardown and reporting, and give each boot only the time that is left, never more than the cap. All
// five real boots still run; what changes is that an overrun fails HERE, attributably, instead of upstream.
const SELF_REL = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join('/');

/** The timeoutMs the validate registry gives THIS file — derived from the row, not restated as a literal. */
function registeredBudgetMs() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8'));
  const rows = (config?.validate?.commands ?? []).filter(row => (row?.args ?? []).includes(SELF_REL));
  assert.equal(
    rows.length,
    1,
    `expected exactly one validate.commands row running '${SELF_REL}', found ${rows.length}. The startup ` +
      `budget below is derived from that row, so fix the registration rather than hardcoding a number here`,
  );
  const ms = rows[0].timeoutMs;
  assert.ok(
    Number.isInteger(ms) && ms > 0,
    `the validate.commands row for '${SELF_REL}' must carry a positive integer timeoutMs, got ${JSON.stringify(ms)}`,
  );
  return ms;
}

const REGISTERED_BUDGET_MS = registeredBudgetMs();
// The validator's clock starts when this process is SPAWNED, not when main() reaches its first boot, so
// anchor the deadline there — the derivation work above a boot is spent out of the same budget.
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);
// Reserve: a timed-out boot must still have room to print the diagnostic below and remove the scratch tree
// before the validator's own kill lands, or the failure is unattributable again.
const BUDGET_RESERVE_MS = 15_000;
const HARNESS_DEADLINE_MS = PROCESS_START_MS + REGISTERED_BUDGET_MS - BUDGET_RESERVE_MS;
// No single boot may consume the whole remaining budget: one slow start must still leave the later controls
// a chance to run and report what they saw.
const STARTUP_TIMEOUT_CAP_MS = 60_000;
// Below this there is no point arming a boot at all — a real startup takes seconds — so refuse
// attributably rather than spawning something certain to be killed mid-flight.
const MIN_STARTUP_BUDGET_MS = 10_000;

const toRepoRel = abs => relative(repoRoot, abs).split(sep).join('/');

// ── source scanning helpers ───────────────────────────────────────────────────────────────────────────

// Blank out comments while preserving string and template contents (the dynamic-import classifier below
// reads path segments out of string literals, so they must survive). Tracks ' " ` and both comment forms.
// It does NOT track regex literals; a regex containing // or /* would mis-slice, so the caller asserts the
// stripped text still looks like the original file.
function stripComments(src) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Source text of the parenthesised argument list whose '(' sits at openIndex, respecting quotes.
function balancedArgs(code, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return null;
}

const stringLiterals = text => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]);
// True when `text` is nothing but string literals and separators — i.e. every path segment is a literal
// and none is computed. Used to fail closed on `join(repoRoot, someVariable)`.
const onlyLiteralSegments = text => text.replace(/'[^']*'|"[^"]*"/g, '').replace(/[\s,]/g, '') === '';

// Module-level `const IDENT = join(repoRoot, 'a', 'b');` declarations, as repo-relative paths.
function collectRepoRootConstants(code) {
  const constants = new Map();
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*join\(\s*repoRoot\s*,([^;]*?)\)\s*;/g)) {
    if (!onlyLiteralSegments(m[2])) continue;
    const segments = stringLiterals(m[2]);
    if (segments.length > 0) constants.set(m[1], segments.join('/'));
  }
  return constants;
}

// Classify one dynamic import argument. Every shape bootstrap uses must land in a named kind; anything
// else is 'unclassified' and fails manifest:1. That fail-closed default is the anti-bypass property:
// a NEW computed dynamic import shape breaks this test instead of silently escaping the manifest check.
function classifyDynamicImport(argText, constants) {
  const arg = argText.trim();

  const viaJoin = arg.match(/^pathToFileURL\(\s*join\(\s*repoRoot\s*,([\s\S]*)\)\s*\)\s*\.href$/);
  if (viaJoin && onlyLiteralSegments(viaJoin[1])) {
    const segments = stringLiterals(viaJoin[1]);
    if (segments.length > 0) return { kind: 'firstParty', rel: segments.join('/'), form: 'join(repoRoot, …)' };
  }

  const viaConst = arg.match(/^pathToFileURL\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.href$/);
  if (viaConst) {
    const rel = constants.get(viaConst[1]);
    // An identifier we cannot resolve back to literal repoRoot segments stays unclassified on purpose.
    if (rel) return { kind: 'firstParty', rel, form: `pathToFileURL(${viaConst[1]})` };
    return { kind: 'unclassified', arg };
  }

  const literal = arg.match(/^'([^']*)'$/) || arg.match(/^"([^"]*)"$/);
  if (literal) {
    const spec = literal[1];
    if (spec.startsWith('.')) return { kind: 'relative', spec };
    return { kind: 'bare', spec };
  }

  return { kind: 'unclassified', arg };
}

// Anchors spread across bin/bootstrap-runner.js — its first statement, the dist constants, the helper
// the classifier is about, and its LAST executable statement. A mis-slicing stripper truncates from the
// bad token to the end of the file, so a tail anchor is what actually detects it.
const BOOTSTRAP_STRIP_ANCHORS = [
  "from 'fs'", 'MAIN_DIST', 'UTILS_DIST', 'LAB_DIST', 'BRAND_ENV_DIST',
  'importDistModules', 'withDistImportLock', 'runLocalBootstrap', 'printBootstrapFailure(err);',
];

function collectDynamicImports(entryAbs, anchors) {
  const raw = readFileSync(entryAbs, 'utf8');
  const code = stripComments(raw);
  // Guard against catastrophic mis-slicing by the comment stripper (see its note on regex literals).
  // Anchors, NOT a fraction of the file's byte size: the stripped result is code-only, so a size ratio
  // measures COMMENT DENSITY, and a heavily documented file trips it while nothing is mis-sliced. What
  // mis-slicing actually does is swallow everything from a mis-read token onward, which the tail anchor
  // catches regardless of how much prose the file carries.
  const missing = anchors.filter(anchor => !code.includes(anchor));
  assert.deepEqual(
    missing,
    [],
    `comment stripping mangled ${toRepoRel(entryAbs)} — the dynamic-import classifier would be reading `
      + `garbage. Missing after stripping: ${JSON.stringify(missing)}`,
  );
  // Idempotence: text that is already comment-free must survive a second pass unchanged. A stripper
  // that ate a string literal or a regex would keep eating on the second pass.
  assert.equal(stripComments(code), code, `stripComments is not idempotent on ${toRepoRel(entryAbs)}`);
  const constants = collectRepoRootConstants(code);
  const sites = [];
  for (const m of code.matchAll(/\bimport\s*\(/g)) {
    const argText = balancedArgs(code, m.index + m[0].length - 1);
    assert.ok(argText !== null, `unterminated dynamic import argument list in ${toRepoRel(entryAbs)} at offset ${m.index}`);
    sites.push({ ...classifyDynamicImport(argText, constants), raw: argText.trim() });
  }
  return sites;
}

// Follow every RELATIVE static import from an entry file, returning the reachable first-party module files
// (absolute paths, including the entry). node: built-ins and bare specifiers terminate a branch.
function collectStaticGraph(entryAbs) {
  const seen = new Set();
  const stack = [entryAbs];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('.')) continue; // node: built-in or bare specifier — not a first-party file
      stack.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}

// Third-party specifiers only. isBuiltin() recognises a built-in written either way (`node:fs` or the
// bare legacy `fs`), which bootstrap uses — a plain `startsWith('node:')` filter would treat `fs` as a
// package to resolve out of node_modules.
const staticBareSpecifiers = fileAbs =>
  [...readFileSync(fileAbs, 'utf8').matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)]
    .map(m => m[1])
    .filter(spec => !spec.startsWith('.') && !isBuiltin(spec));

// ── the real asset manifest, derived without running packaging ─────────────────────────────────────────

// Evaluate scripts/package-desktop.mjs's OWN listFiles() and `files` array literal against this checkout.
// Deriving the real list (rather than regex-matching the source for string literals, as this test used to)
// is what lets every check below assert against what would actually be packaged, including the wholesale
// listFiles() spreads.
async function deriveAssetManifestFiles(scratchDir) {
  const src = readFileSync(join(repoRoot, PACKAGE_DESKTOP_REL), 'utf8');
  const listFilesMatch = src.match(/\nfunction listFiles\(relPath\) \{[\s\S]*?\n\}\n/);
  assert.ok(listFilesMatch, `could not extract listFiles() from ${PACKAGE_DESKTOP_REL} — update this derivation`);
  // Scope the array search to writeAssetManifest's body first. listFiles() has its own `const files = []`
  // accumulator, so an unscoped search matches THAT declaration and then runs on to writeAssetManifest's
  // `.sort()`, capturing a block that spans the gap between them.
  const writeFnMatch = src.match(/\nfunction writeAssetManifest\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(writeFnMatch, `could not extract writeAssetManifest() from ${PACKAGE_DESKTOP_REL} — update this derivation`);
  const filesBlockMatch = writeFnMatch[0].match(/const\s+files\s*=\s*\[([\s\S]*?)\]\s*\.sort\(\)/);
  assert.ok(filesBlockMatch, `could not locate the asset-manifest 'files' array in ${PACKAGE_DESKTOP_REL}`);

  const modulePath = join(scratchDir, 'derived-asset-manifest.mjs');
  writeFileSync(
    modulePath,
    `import { readdirSync, statSync } from 'node:fs';\n` +
      `import { join } from 'node:path';\n` +
      `const repoRoot = ${JSON.stringify(repoRoot)};\n` +
      `${listFilesMatch[0]}\n` +
      `export const files = [${filesBlockMatch[1]}].sort();\n`,
    'utf8',
  );
  let derived;
  try {
    ({ files: derived } = await import(pathToFileURL(modulePath).href));
  } catch (error) {
    // listFiles() throws ENOENT on an unbuilt checkout. Say so instead of degrading into a skip: a skip
    // here would be a false pass for exactly the regression this file exists to catch.
    assert.fail(
      `could not derive the desktop asset manifest from ${PACKAGE_DESKTOP_REL}: ${error.message}\n` +
        `If a packages/<pkg>/dist path is missing, build first: npm --prefix packages/main run build ` +
        `(and packages/utils, packages/lab).`,
    );
  }
  assert.ok(Array.isArray(derived) && derived.length > 0, 'the derived desktop asset manifest is empty');
  assert.ok(derived.includes(BOOTSTRAP_REL), `the derived asset manifest must ship ${BOOTSTRAP_REL} itself`);
  return derived;
}

// ── node_modules resolution, the way Node does it ─────────────────────────────────────────────────────

const packageNameOf = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

// Walk up node_modules from the importer's directory exactly like Node's CJS/ESM resolver, so a package
// with a NESTED copy of a dependency resolves to that nested copy rather than the hoisted root one.
function resolvePackageDir(spec, fromDirAbs) {
  const name = packageNameOf(spec);
  let dir = fromDirAbs;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function listFilesUnder(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesUnder(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

// BFS the runtime dependency closure. Edges come from each package's own `dependencies` (what npm installs
// for runtime), resolved FROM that package's directory so nesting is honoured at every hop.
function resolveRuntimeClosure(roots) {
  const resolved = new Map(); // repo-relative package dir → { name, dirAbs, importedFrom }
  const queue = roots.map(root => ({ ...root }));
  const unresolved = [];
  while (queue.length > 0) {
    const { spec, fromDirAbs, importedFrom } = queue.shift();
    const dirAbs = resolvePackageDir(spec, fromDirAbs);
    if (!dirAbs) { unresolved.push({ spec, importedFrom }); continue; }
    const dirRel = toRepoRel(dirAbs);
    if (resolved.has(dirRel)) continue;
    resolved.set(dirRel, { name: packageNameOf(spec), dirAbs, dirRel, importedFrom });
    const manifest = JSON.parse(readFileSync(join(dirAbs, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ spec: dep, fromDirAbs: dirAbs, importedFrom: dirRel });
    }
  }
  return { resolved: [...resolved.values()], unresolved };
}

// ── packaged runtime materialisation ──────────────────────────────────────────────────────────────────

// Mirror pkg-entry's prepareRuntime(): copy each manifest entry into the runtime root and fail loudly on a
// missing source, exactly as copyIntoRuntime() does. Hard links keep this bounded (~5k files); they are
// indistinguishable from copies for module resolution, and the fixture is never written to.
function materialize(runtimeRoot, rels) {
  for (const rel of rels) {
    const from = join(repoRoot, rel);
    const to = join(runtimeRoot, rel);
    assert.ok(existsSync(from), `the desktop asset manifest lists '${rel}', which does not exist in this checkout`);
    mkdirSync(dirname(to), { recursive: true });
    try { linkSync(from, to); } catch { copyFileSync(from, to); }
  }
}

/** Every file under a repo-relative directory, as repo-relative paths materialize() can take. */
function repoFilesUnder(rel) {
  const out = [];
  const walk = (dirRel) => {
    for (const entry of readdirSync(join(repoRoot, dirRel), { withFileTypes: true })) {
      const childRel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(rel);
  return out;
}

const majorOf = (dirRel) => String(JSON.parse(readFileSync(join(repoRoot, dirRel, 'package.json'), 'utf8')).version)
  .split('.')[0];

const WITNESS_ENTRY = 'packaged-startup-witness.mjs';

// The packaged runtime's own entrypoint is generated by writePkgEntrypoint(), not shipped by the manifest,
// so the witness supplies the same two steps: resolve bin/bootstrap-runner.js inside the runtime root and
// call its runLocalBootstrap(). Everything it can reach comes from the manifest.
function writeWitnessEntry(runtimeRoot) {
  writeFileSync(
    join(runtimeRoot, WITNESS_ENTRY),
    `import { dirname, join } from 'node:path';\n` +
      `import { fileURLToPath, pathToFileURL } from 'node:url';\n` +
      `const runtimeRoot = dirname(fileURLToPath(import.meta.url));\n` +
      `const bootstrap = await import(pathToFileURL(join(runtimeRoot, 'bin', 'bootstrap-runner.js')).href);\n` +
      `if (typeof bootstrap.runLocalBootstrap !== 'function') {\n` +
      `  console.error('Packaged ProofOrStop bootstrap does not export runLocalBootstrap().');\n` +
      `  process.exit(1);\n` +
      `}\n` +
      `await bootstrap.runLocalBootstrap();\n`,
    'utf8',
  );
}

// `invocationCwd` models where a desktop USER runs the binary. pkg-entry materialises the runtime root
// under os.tmpdir() and never chdirs into it, so the runtime root is deliberately NOT the cwd here: with
// cwd inside it the CLI sees packages/main/package.json, believes it is running against the ProofOrStop
// self-host checkout, and refuses before dispatch with runtime_authority_unresolved_in_worktree.
function startPackagedRuntime(runtimeRoot, invocationCwd, label) {
  const remainingMs = HARNESS_DEADLINE_MS - Date.now();
  assert.ok(
    remainingMs >= MIN_STARTUP_BUDGET_MS,
    `no budget left to start the '${label}' packaged runtime: ${remainingMs}ms remain of this file's ` +
      `registered ${REGISTERED_BUDGET_MS}ms (minus a ${BUDGET_RESERVE_MS}ms teardown reserve), and a real ` +
      `startup needs at least ${MIN_STARTUP_BUDGET_MS}ms. The boots before this one were slower than the ` +
      `registration assumes: raise timeoutMs on this file's validate.commands row, or reduce the number of ` +
      `boots. Do NOT widen the per-boot cap — that is what let five boots exceed the file budget silently.`,
  );
  const budgetMs = Math.min(remainingMs, STARTUP_TIMEOUT_CAP_MS);
  const res = spawnSync(process.execPath, [join(runtimeRoot, WITNESS_ENTRY), '--version'], {
    cwd: invocationCwd,
    encoding: 'utf8',
    timeout: budgetMs,
    env: { ...process.env, PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME: '1' },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.ok(
    res.error?.code !== 'ETIMEDOUT',
    `the '${label}' packaged-runtime startup did not finish within the ${budgetMs}ms slice it was given ` +
      `(${remainingMs}ms remained of the registered ${REGISTERED_BUDGET_MS}ms file budget when it started):\n` +
      `${out.slice(0, 800)}`,
  );
  return { status: res.status, out };
}

// ── the checks ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'red-1734-desktop-manifest-'));
  try {
    const manifestFiles = await deriveAssetManifestFiles(scratch);
    const manifestSet = new Set(manifestFiles);

    // ── manifest:0 — every scripts/ module in bootstrap's STATIC graph is shipped (B-1734 D1) ─────────
    const staticGraph = collectStaticGraph(BOOTSTRAP_ABS);
    {
      const scriptDeps = [...staticGraph].map(toRepoRel).filter(rel => rel.startsWith('scripts/')).sort();
      assert.ok(
        scriptDeps.length > 0,
        'expected bin/bootstrap-runner.js to statically import at least one scripts/ module to guard (none found — the parser or the graph changed)',
      );
      for (const dep of scriptDeps) {
        assert.ok(
          manifestSet.has(dep),
          `bin/bootstrap-runner.js statically imports '${dep}' (directly or transitively) but the desktop ` +
            `asset manifest does not ship it — the packaged desktop runtime would crash with ` +
            `ERR_MODULE_NOT_FOUND at bootstrap module-init (B-1734 D1). Add '${dep}' to writeAssetManifest's files array.`,
        );
      }
      console.log(`VI-OK D1:manifest:0 (${scriptDeps.join(', ')})`);
    }

    // ── manifest:1 — every dynamic import site in bootstrap is classified (fail closed) ───────────────
    const dynamicSites = collectDynamicImports(BOOTSTRAP_ABS, BOOTSTRAP_STRIP_ANCHORS);
    {
      assert.ok(
        dynamicSites.length > 0,
        `found no dynamic import() site in ${BOOTSTRAP_REL} — bootstrap loads dist entries dynamically, so ` +
          `an empty result means the scanner broke, not that the imports are gone`,
      );
      const unclassified = dynamicSites.filter(site => site.kind === 'unclassified');
      assert.deepEqual(
        unclassified.map(site => site.raw),
        [],
        `${BOOTSTRAP_REL} contains dynamic import() argument shapes this guard cannot resolve to a concrete ` +
          `module, so it cannot prove the desktop asset manifest ships them. Either write the import in a ` +
          `recognised form — import(pathToFileURL(join(repoRoot, '<literal>', …)).href), ` +
          `import(pathToFileURL(<MODULE_LEVEL_CONST>).href) or import('<bare-specifier>') — or teach ` +
          `classifyDynamicImport() the new shape. Refusing to guess is deliberate: a computed specifier that ` +
          `silently fell out of this set is exactly how B-bcae F-008 shipped.`,
      );
      const summary = dynamicSites
        .map(site => (site.kind === 'bare' ? `bare:${site.spec}` : site.kind === 'relative' ? `rel:${site.spec}` : site.rel))
        .sort();
      console.log(`VI-OK D1:manifest:1 (${dynamicSites.length} dynamic import sites classified: ${summary.join(', ')})`);
    }

    // ── manifest:2 — every DYNAMICALLY reached first-party module is shipped ──────────────────────────
    // First-party SOURCE modules (bin/, scripts/) additionally contribute their own transitive static
    // graph: reaching scripts/build-lock.mjs is useless if what it statically imports is not shipped too.
    const firstPartySourceModules = new Set([...staticGraph].map(toRepoRel));
    {
      const dynamicFirstParty = [...new Set(dynamicSites.filter(s => s.kind === 'firstParty').map(s => s.rel))].sort();
      assert.ok(
        dynamicFirstParty.length > 0,
        `${BOOTSTRAP_REL} must reach at least one first-party module dynamically (the dist entries); none found`,
      );
      const required = new Set(dynamicFirstParty);
      for (const rel of dynamicFirstParty) {
        if (!rel.startsWith('bin/') && !rel.startsWith('scripts/')) continue; // compiled dist entry — see SCOPE
        const abs = join(repoRoot, rel);
        assert.ok(existsSync(abs), `${BOOTSTRAP_REL} dynamically imports '${rel}', which does not exist in this checkout`);
        for (const dep of collectStaticGraph(abs)) {
          const depRel = toRepoRel(dep);
          required.add(depRel);
          firstPartySourceModules.add(depRel);
        }
      }
      for (const rel of [...required].sort()) {
        assert.ok(
          manifestSet.has(rel),
          `bin/bootstrap-runner.js reaches '${rel}' on the startup path by DYNAMIC import (directly, or ` +
            `statically from a dynamically imported first-party helper) but the desktop asset manifest does ` +
            `not ship it. A packaged runtime always has dist present, so bootstrap ALWAYS takes that branch ` +
            `and would exit 1 with "local bootstrap is not ready" (B-bcae F-008/F-017). Add '${rel}' to ` +
            `writeAssetManifest's files array.`,
        );
      }
      console.log(`VI-OK D1:manifest:2 (${[...required].sort().join(', ')})`);
    }

    // ── manifest:3 — the transitive third-party closure of that first-party set is shipped ────────────
    {
      const roots = [];
      for (const rel of [...firstPartySourceModules].sort()) {
        if (!rel.startsWith('bin/') && !rel.startsWith('scripts/')) continue;
        const abs = join(repoRoot, rel);
        for (const spec of staticBareSpecifiers(abs)) roots.push({ spec, fromDirAbs: dirname(abs), importedFrom: rel });
      }
      for (const site of dynamicSites) {
        if (site.kind === 'bare' && !isBuiltin(site.spec)) {
          roots.push({ spec: site.spec, fromDirAbs: dirname(BOOTSTRAP_ABS), importedFrom: BOOTSTRAP_REL });
        }
      }
      assert.ok(
        roots.length > 0,
        `expected bootstrap's first-party module set to need at least one third-party package (build-lock.mjs ` +
          `imports proper-lockfile); found none, so the closure scanner is broken rather than the tree being clean`,
      );

      const { resolved, unresolved } = resolveRuntimeClosure(roots);
      assert.deepEqual(
        unresolved,
        [],
        `could not resolve third-party packages bootstrap's first-party modules need: ${JSON.stringify(unresolved)}. ` +
          `Run npm install at the repository root.`,
      );

      for (const pkg of resolved) {
        const missing = listFilesUnder(pkg.dirAbs).map(toRepoRel).filter(rel => !manifestSet.has(rel));
        assert.deepEqual(
          missing.slice(0, 5),
          [],
          `the packaged desktop runtime needs '${pkg.name}' at ${pkg.dirRel} (required by ${pkg.importedFrom}), ` +
            `but the desktop asset manifest omits ${missing.length} of its files, starting with ` +
            `${JSON.stringify(missing.slice(0, 5))}. Add a listFiles('${pkg.dirRel}') spread to ` +
            `writeAssetManifest's files array — shipping a DIFFERENT copy of the same package name does not ` +
            `satisfy this, because Node resolves it from ${pkg.importedFrom}'s location.`,
        );
      }

      // Make the nesting explicit in the receipt: a package resolved through a SECOND node_modules segment
      // is a nested copy, and the assertion above pinned that exact directory, not the hoisted sibling.
      const nested = resolved.filter(pkg => pkg.dirRel.split('/node_modules/').length > 2);
      for (const pkg of nested) {
        const hoisted = `node_modules/${pkg.name}`;
        assert.ok(
          manifestSet.has(`${pkg.dirRel}/package.json`),
          `Node resolves '${pkg.name}' from ${pkg.importedFrom} to the NESTED ${pkg.dirRel}, so that is the copy ` +
            `the packaged runtime must ship; ${hoisted} is a different install and does not substitute for it`,
        );
      }
      console.log(
        `VI-OK D1:manifest:3 (${resolved.map(p => p.dirRel).sort().join(', ')}` +
          `${nested.length > 0 ? ` | nested resolutions pinned: ${nested.map(p => p.dirRel).sort().join(', ')}` : ''})`,
      );
    }

    // ── manifest:4 — bounded packaged-runtime startup witness ─────────────────────────────────────────
    // Everything above is derivation. This is the executable proof that the derived manifest is USABLE:
    // a runtime root containing exactly those files boots through bootstrap-runner and answers a command.
    const runtimeRoot = join(scratch, 'runtime');
    // An empty directory standing in for wherever a desktop user happens to invoke the binary.
    const invocationCwd = join(scratch, 'invocation-cwd');
    mkdirSync(invocationCwd, { recursive: true });
    {
      materialize(runtimeRoot, manifestFiles);
      writeWitnessEntry(runtimeRoot);
      const { status, out } = startPackagedRuntime(runtimeRoot, invocationCwd, 'manifest:4 witness');
      assert.equal(
        status,
        0,
        `a packaged desktop runtime built from EXACTLY the derived asset manifest must start and answer ` +
          `--version, got exit ${status}:\n${out.slice(0, 1200)}`,
      );
      assert.ok(
        !/local bootstrap is not ready/i.test(out),
        `the packaged runtime reached bootstrap's failure path, so the manifest is incomplete:\n${out.slice(0, 1200)}`,
      );
      assert.ok(
        !/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(out),
        `the packaged runtime hit an unresolved module, so the manifest is incomplete:\n${out.slice(0, 1200)}`,
      );
      assert.ok(
        /\d+\.\d+\.\d+/.test(out),
        `the packaged runtime must actually answer --version with a version string:\n${out.slice(0, 1200)}`,
      );
      console.log(`VI-OK D1:manifest:4 (${manifestFiles.length} manifest files materialised; startup exit 0: ${out.trim().split('\n')[0]})`);
    }

    // ── manifest:5 — controls: the witness above detects each newly required asset ────────────────────
    // Without these, manifest:4 could pass for reasons unrelated to what B-bcae added. Each case removes
    // ONE asset from the same runtime root, asserts startup now fails, then restores it.
    {
      const controls = [
        {
          label: 'scripts/build-lock.mjs',
          rel: 'scripts/build-lock.mjs',
          why: "bootstrap dynamically imports it for reader admission on every packaged startup",
        },
        {
          label: 'node_modules/proper-lockfile',
          rel: 'node_modules/proper-lockfile',
          why: 'scripts/build-lock.mjs statically imports it',
        },
        {
          // SUBSTITUTION control, not a mere removal (B-bcae F-053). Deleting the nested copy alone
          // proves only "some signal-exit must be shipped": the manifest ships exactly one, so the
          // runtime root is left with none and startup fails for the weaker reason that the module is
          // absent. That exit is equally produced by a tree whose two copies were identical, or whose
          // hoisted copy were the correct major — i.e. by facts that leave the stated proposition
          // untested. So put the hoisted root copy in its place and require startup to fail ANYWAY.
          // That is the direct proof that the hoisted copy does not substitute, and it is what a later
          // maintainer deduping to the root install would be reversing.
          label: 'node_modules/proper-lockfile/node_modules/signal-exit (nested copy replaced by the hoisted root copy)',
          rel: 'node_modules/proper-lockfile/node_modules/signal-exit',
          substitute: 'node_modules/signal-exit',
          why:
            'proper-lockfile resolves signal-exit to its NESTED copy; the hoisted root copy is a different ' +
            'major whose CommonJS export is an object, not the callable proper-lockfile invokes at module-init',
          // Nonzero alone would still be satisfied by the substitute never being resolved at all, which is
          // the weaker proposition this control exists to escape. So require the failure to be the CALL
          // failing, and require it NOT to be an unresolved module.
          failureMustMatch: /is not a function/i,
          failureMustNotMatch: /Cannot find module '?signal-exit/i,
        },
      ];
      const observed = [];
      for (const control of controls) {
        const shipped = manifestFiles.filter(rel => rel === control.rel || rel.startsWith(`${control.rel}/`));
        assert.ok(
          shipped.length > 0,
          `control '${control.label}' expects the manifest to ship ${control.rel} (${control.why}); it ships nothing there`,
        );
        rmSync(join(runtimeRoot, control.rel), { recursive: true, force: true });
        let substituted = [];
        if (control.substitute) {
          // Premises, asserted rather than assumed — each one is a way this control could quietly stop
          // testing what it claims.
          assert.ok(
            existsSync(join(repoRoot, control.substitute)),
            `control '${control.label}' needs ${control.substitute} present in this checkout to stand in for the ` +
              `nested copy; without it this degrades to a plain removal and proves only that SOME copy is required`,
          );
          assert.equal(
            manifestFiles.some(rel => rel === control.substitute || rel.startsWith(`${control.substitute}/`)),
            false,
            `${control.substitute} must NOT be in the derived manifest: the control materialises it as an ` +
              `ADDITION to the manifest root and removes it again afterwards, which only restores the exact ` +
              `manifest if it was never shipped`,
          );
          const nestedMajor = majorOf(control.rel);
          const hoistedMajor = majorOf(control.substitute);
          assert.notEqual(
            hoistedMajor,
            nestedMajor,
            `the substitution control asserts the hoisted copy is a DIFFERENT major that cannot serve; both ` +
              `resolve to major ${hoistedMajor} in this checkout, so a startup failure here would not ` +
              `distinguish the two copies. Re-derive the claim before relying on this control`,
          );
          substituted = repoFilesUnder(control.substitute);
          materialize(runtimeRoot, substituted);
        }
        const { status, out } = startPackagedRuntime(runtimeRoot, invocationCwd, `manifest:5 control ${control.label}`);
        assert.notEqual(
          status,
          0,
          `removing ${control.label} from the packaged runtime must break startup — ${control.why}. It exited 0 ` +
            `instead, so the manifest:4 witness does not actually depend on this asset and would not have ` +
            `caught B-bcae F-008/F-017:\n${out.slice(0, 800)}`,
        );
        if (control.failureMustMatch) {
          assert.match(
            out,
            control.failureMustMatch,
            `control '${control.label}' must fail for the stated reason (${control.why}), not merely fail:\n${out.slice(0, 800)}`,
          );
        }
        if (control.failureMustNotMatch) {
          assert.doesNotMatch(
            out,
            control.failureMustNotMatch,
            `control '${control.label}' failed with an unresolved module, so the substituted copy was never ` +
              `reached and this proves only that SOME copy is required:\n${out.slice(0, 800)}`,
          );
        }
        observed.push(`${control.label} → exit ${status}`);
        if (substituted.length > 0) rmSync(join(runtimeRoot, control.substitute), { recursive: true, force: true });
        materialize(runtimeRoot, shipped);
      }

      // Restored: the same root must start again, proving each control failure came from the removal and
      // not from a runtime the earlier runs left permanently broken.
      const restored = startPackagedRuntime(runtimeRoot, invocationCwd, 'manifest:5 restored runtime');
      assert.equal(
        restored.status,
        0,
        `after restoring every control asset the packaged runtime must start again, got exit ${restored.status}:\n` +
          `${restored.out.slice(0, 1200)}`,
      );
      console.log(`VI-OK D1:manifest:5 (${observed.join('; ')}; restored startup exit 0)`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    'PASS red-1734-desktop-asset-manifest: every scripts/ module in bin/bootstrap-runner.js\'s static import ' +
      'graph is shipped by the desktop asset manifest, every dynamic import site is classified and its ' +
      'first-party target shipped, the Node-resolved transitive third-party closure (including the nested ' +
      'proper-lockfile signal-exit) is shipped, and a runtime root built from exactly that manifest starts ' +
      'and answers --version while failing when any of those assets is removed',
  );
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
