/**
 * Proves an unsupported Node runtime gets a readable diagnostic, not a raw stack trace.
 *
 * `src/core/search/fn.ts` imports `DatabaseSync` from `node:sqlite`, which lands in Node
 * 22.5. On anything older the dynamic import of this library throws
 * `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` with a stack pointing
 * at `node:internal/modules/esm/translators` — a trace that names neither the required
 * version nor what the user should do about it. This check exists because a guard nobody
 * ever watches fail is not evidence that the guard works.
 *
 * Two things are asserted, and BOTH must hold:
 *
 *   1. The message names all three facts a reader needs: the module (`node:sqlite`), the
 *      required range (read from this package's own `engines.node`), and the version
 *      actually running. A message missing any one of them is not diagnosable.
 *   2. It is NOT the raw builtin error. `ERR_UNKNOWN_BUILTIN_MODULE` or an internal stack
 *      frame leaking into the message means the guard was placed after the import and did
 *      not actually preempt it.
 *
 * The floor is asserted to live in exactly one place. A second hardcoded copy of the
 * version in the handler would be free to drift from the manifest npm enforces on install,
 * so the check fails if the handler stops sourcing the range from `engines.node`.
 *
 * Where possible this runs the guard on a REAL pre-22.5 Node found under nvm, which is a
 * true negative control: the same binary is first shown to produce the raw
 * ERR_UNKNOWN_BUILTIN_MODULE when the library is imported directly. When no such runtime
 * is installed it degrades to calling the pure decision function with an old version
 * string, and says so — a weaker proof, but an honest one rather than a skip.
 *
 * Subprocesses use execFileSync with an argv array and no shell, so the interpolated
 * absolute paths below are arguments rather than shell text.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repo = path.resolve(pkgRoot, '..', '..');
const handlerDist = path.join(repo, 'packages', 'main', 'dist', 'handlers', 'graph.js');

const failures = [];
const notes = [];

const range = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).engines?.node;
if (range !== '>=22.5.0') {
  failures.push(`engines.node is ${JSON.stringify(range)}, expected ">=22.5.0" (the node:sqlite floor)`);
}

if (!fs.existsSync(handlerDist)) {
  console.error('PRECONDITION_FAILED: packages/main is not built; run npm --prefix packages/main run build');
  process.exit(1);
}

/** The floor must be sourced from engines.node, not re-hardcoded in the handler. */
const handlerSrc = fs.readFileSync(path.join(repo, 'packages', 'main', 'src', 'handlers', 'graph.ts'), 'utf8');
if (!handlerSrc.includes('readGraphEnginesRange')) {
  failures.push('handler no longer reads engines.node; the required version may have been hardcoded');
}
if (/requiredRange[^\n]*['"`]>=?22\.5/.test(handlerSrc)) {
  failures.push('handler appears to hardcode the 22.5 floor instead of reading engines.node');
}

/** Assert a captured message is the readable diagnostic and not the raw builtin error. */
const assertReadable = (label, message, runningVersion) => {
  for (const needle of ['node:sqlite', range]) {
    if (!message.includes(needle)) failures.push(`${label}: message does not name ${JSON.stringify(needle)}`);
  }
  if (!message.includes(runningVersion)) {
    failures.push(`${label}: message does not name the running version ${runningVersion}`);
  }
  if (message.includes('ERR_UNKNOWN_BUILTIN_MODULE')) {
    failures.push(`${label}: raw ERR_UNKNOWN_BUILTIN_MODULE leaked — the guard ran too late`);
  }
  if (/at ModuleLoader|node:internal\//.test(message)) {
    failures.push(`${label}: an internal stack frame leaked into the message`);
  }
};

/** Find an installed Node that genuinely predates node:sqlite (22.5). */
const findOldNode = () => {
  const versionsDir = path.join(process.env.HOME ?? '', '.nvm', 'versions', 'node');
  if (!fs.existsSync(versionsDir)) return null;
  const older = fs.readdirSync(versionsDir)
    .map(name => ({ name, m: /^v(\d+)\.(\d+)\./.exec(name) }))
    .filter(({ m }) => m && (Number(m[1]) < 22 || (Number(m[1]) === 22 && Number(m[2]) < 5)))
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2]) - Number(a.m[2]));
  for (const { name } of older) {
    const bin = path.join(versionsDir, name, 'bin', 'node');
    if (fs.existsSync(bin)) return bin;
  }
  return null;
};

const run = (bin, script) =>
  execFileSync(bin, ['--input-type=module', '-e', script],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

const oldNode = findOldNode();

if (oldNode) {
  const oldVersion = execFileSync(oldNode, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');

  // Negative control: the unguarded import really does explode on this exact binary.
  // Without this, a "readable message" proves nothing — the runtime might have been fine.
  let rawCode = '';
  try {
    rawCode = run(oldNode, `
      try { await import(${JSON.stringify(path.join(pkgRoot, 'dist', 'core', 'search', 'fn.js'))}); console.log('NO_ERROR'); }
      catch (e) { console.log(e.code ?? 'NO_CODE'); }
    `).trim();
  } catch (e) {
    rawCode = `SPAWN_FAILED: ${e.message}`;
  }
  if (rawCode !== 'ERR_UNKNOWN_BUILTIN_MODULE') {
    failures.push(`negative control invalid on v${oldVersion}: unguarded import reported ${rawCode}, expected ERR_UNKNOWN_BUILTIN_MODULE`);
  } else {
    notes.push(`negative control: unguarded import on v${oldVersion} throws ERR_UNKNOWN_BUILTIN_MODULE`);
  }

  // The guard itself, through the real handler, on the real old runtime.
  let guarded = '';
  try {
    guarded = run(oldNode, `
      const { createGraphHandlers } = await import(${JSON.stringify(handlerDist)});
      const handlers = createGraphHandlers({ root: ${JSON.stringify(repo)}, log: () => {} });
      try { await handlers.graph({ json: true }); console.log('GUARD_DID_NOT_FIRE'); }
      catch (e) { console.log(e.message); }
    `);
  } catch (e) {
    guarded = `SPAWN_FAILED: ${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
  }
  if (guarded.includes('GUARD_DID_NOT_FIRE')) {
    failures.push(`the guard did not fire on v${oldVersion} — graph ran anyway`);
  } else {
    assertReadable(`real v${oldVersion}`, guarded, oldVersion);
    notes.push(`guard on real v${oldVersion} produced a readable diagnostic:\n${guarded.trim().split('\n').map(l => `    ${l}`).join('\n')}`);
  }
} else {
  // No genuinely-old Node installed: exercise the pure decision function instead.
  const message = run(process.execPath, `
    const { graphRuntimeUnsupportedMessage, readGraphEnginesRange } = await import(${JSON.stringify(handlerDist)});
    console.log(graphRuntimeUnsupportedMessage({
      nodeVersion: '22.4.1',
      builtinAvailable: false,
      requiredRange: readGraphEnginesRange(${JSON.stringify(pkgRoot)}),
    }));
  `);
  assertReadable('pure fn (simulated 22.4.1)', message, '22.4.1');
  notes.push('no pre-22.5 Node installed; exercised the pure decision function only (weaker proof)');
  notes.push(`simulated 22.4.1 message:\n${message.trim().split('\n').map(l => `    ${l}`).join('\n')}`);
}

// The supported case must stay silent, or the guard would reject every good runtime.
const supported = run(process.execPath, `
  const { graphRuntimeUnsupportedMessage } = await import(${JSON.stringify(handlerDist)});
  console.log(String(graphRuntimeUnsupportedMessage({
    nodeVersion: process.versions.node, builtinAvailable: true, requiredRange: ${JSON.stringify(range)},
  })));
`).trim();
if (supported !== 'null') {
  failures.push(`a supported runtime was rejected: expected null, got ${JSON.stringify(supported)}`);
}

for (const n of notes) console.log(n);

if (failures.length) {
  console.error('ENGINES_FLOOR_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`engines.node=${range} declared once, sourced from the manifest; supported runtimes pass`);
console.log('ENGINES_FLOOR_OK');
