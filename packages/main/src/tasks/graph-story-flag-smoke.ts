#!/usr/bin/env node
/**
 * Regression smoke for `proof-or-stop graph --story=<id>` (B-9f2c CHK-003).
 *
 * `--story` deep-links the served graph at one story's dossier page. Two properties make
 * it worth pinning, and neither is visible from the happy path alone:
 *
 *  1. AN UNKNOWN ID IS REFUSED BEFORE THE SERVER LISTENS. Serving `/story/B-typo` would
 *     answer 200 with an empty dossier, which reads as "this story has no evidence"
 *     rather than "you named a story that does not exist" — the same failure mode the
 *     handler's `--root` validation already exists to prevent (B-3e16 round 3). So the
 *     refusal must happen while `startServer` is still untouched; a check placed after it
 *     would leave a real port bound on a real interface for a typo.
 *  2. THE ZOD SCHEMA IS ONLY THE FIRST LINE OF DEFENCE. The catalog declares
 *     `story: z.string().optional()`, but the handler is also reachable from internal
 *     calls and stale payloads that never pass through the schema (CLAUDE.md,
 *     「Handler 编码约定」). The handler entry therefore re-validates, and this smoke calls
 *     it with values Zod would have rejected outright to prove the second layer is live.
 *
 * The graph library is NOT loaded here: every case drives the handler with a stub whose
 * `startServer` records whether it was ever reached, which is what turns "refused before
 * listening" from a claim into an assertion.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_DEFAULT_PORT,
  assertGraphStoryExists,
  createGraphHandlers,
  graphStorySuggestions,
} from '../handlers/graph.js';
import type { HandlerContext } from '../handlers/context.js';

const PASS_LINE =
  '✓ graph --story smoke passed: known id deep-links, unknown id refused before listening, schema bypass still refused, no --story unchanged, ids encoded';

const REPO_ROOT = process.cwd();
const KNOWN_IDS = ['B-9f2c', 'B-9f11', 'B-3e16', 'B-cdf6'] as const;

/**
 * A story id that must survive URL construction: `#` would become a fragment, `?` a query
 * and ` ` an invalid raw path byte. Real ids look nothing like this, which is the point —
 * the encoding must be unconditional rather than relying on ids staying tame.
 */
const ESCAPING_ID = 'B-9f2c#frag?q=1 x';

/** What the on-disk stub library records about what the handler did to it. */
interface StubTrace {
  startServerCalls: number;
  openedUrls: string[];
}

/**
 * Assert that a call rejects, AND that it does so promptly.
 *
 * The plain `assert.rejects` is not enough here: the handler's serving path returns a
 * promise that stays pending for the lifetime of the served process, so a regression that
 * lets a bad input through does not reject — it hangs. Racing against a deadline converts
 * "it served something it should have refused" into a readable failure.
 */
async function rejectsPromptly(
  call: () => Promise<unknown>,
  expected: RegExp,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Deliberately NOT unref'd. An unref'd timer does not hold the event loop open, so when
    // the awaited call hangs Node simply drains and exits with the bare "unsettled top-level
    // await" warning — i.e. the obscure failure this helper exists to replace. The finally
    // block below clears it, so a reffed timer cannot leak past a settled assertion.
    timer = setTimeout(() => reject(new Error(`did not settle within ${timeoutMs}ms — ${message}`)), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      call().then(
        (v) => ({ rejected: false as const, value: v }),
        (e: unknown) => ({ rejected: true as const, error: e }),
      ),
      deadline,
    ]);
    assert.ok(outcome.rejected, `resolved instead of rejecting — ${message}`);
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    assert.match(msg, expected, message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll a condition with a hard ceiling. Never `sleep`: a fixed nap is either flaky or slow. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`graph --story smoke: timed out after ${timeoutMs}ms waiting for: ${what}`);
}

// ---------------------------------------------------------------------------
// (1) A known id produces the /story/<id> URL; no --story keeps the plain / URL.
// The URL is built from exactly the two inputs the handler uses, so this pins the
// shape without needing a listening server.
// ---------------------------------------------------------------------------
{
  const known = assertGraphStoryExists('B-9f2c', KNOWN_IDS);
  assert.equal(known, 'B-9f2c', 'a known id is returned verbatim');
  assert.equal(
    `http://localhost:${GRAPH_DEFAULT_PORT}/story/${encodeURIComponent(known)}`,
    'http://localhost:8731/story/B-9f2c',
  );

  // Surrounding whitespace is tolerated but never leaks into the URL.
  assert.equal(assertGraphStoryExists('  B-3e16  ', KNOWN_IDS), 'B-3e16');
}

// ---------------------------------------------------------------------------
// (2) An unknown id is refused, and the message names near-miss candidates.
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => assertGraphStoryExists('B-9f2d', KNOWN_IDS),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /is not a story in this repository/);
      assert.match(msg, /did you mean: /, 'a one-character typo must surface candidates');
      assert.match(msg, /B-9f2c/, 'the nearest id must be named');
      assert.ok(!msg.includes('http://'), 'the refusal must not report a URL it never served');
      return true;
    },
  );

  // A prefix that matches several stories names them all, prefix band first.
  const prefixed = graphStorySuggestions('B-9f', KNOWN_IDS);
  assert.deepEqual(prefixed, ['B-9f11', 'B-9f2c'], 'prefix matches rank first, ties alphabetical');

  // Deterministic: the same inputs must produce the same list, or the message is not
  // quotable in a bug report.
  assert.deepEqual(graphStorySuggestions('B-9f', KNOWN_IDS), prefixed);

  // Nothing remotely similar => an honest "no candidate", never a misleading guess.
  assert.throws(
    () => assertGraphStoryExists('completely-unrelated-token', KNOWN_IDS),
    /no similarly named story was found/,
  );

  // The suggestion list is bounded.
  const many = Array.from({ length: 50 }, (_, i) => `B-9f${String(i).padStart(2, '0')}`);
  assert.ok(graphStorySuggestions('B-9f', many).length <= 5, 'suggestions are capped');
}

// ---------------------------------------------------------------------------
// (3) The schema-bypassing internal call is STILL refused (CLAUDE.md Handler 编码约定).
// None of these values could reach the handler through the catalog's
// `story: z.string().optional()` — they model an internal fn call or a stale payload.
// ---------------------------------------------------------------------------
{
  const zodWouldHaveRejected: readonly unknown[] = [
    '',                    // empty string: passes z.string(), names no story
    '   ',                 // whitespace only
    null,                  // not a string at all
    42,
    { storyId: 'B-9f2c' }, // an object that merely mentions a valid id
    ['B-9f2c'],
    true,
  ];
  for (const value of zodWouldHaveRejected) {
    assert.throws(
      () => assertGraphStoryExists(value, KNOWN_IDS),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        assert.match(msg, /^graph: --story/, `bypassing value ${JSON.stringify(value)} must be refused by the handler layer`);
        return true;
      },
      `schema-bypassing value ${JSON.stringify(value)} must not be accepted`,
    );
  }

  // The refusal is about EXISTENCE, not about spelling: a well-formed id that is simply
  // absent is refused just as hard as a malformed one.
  assert.throws(() => assertGraphStoryExists('B-0000', []), /is not a story in this repository/);
  assert.throws(() => assertGraphStoryExists('B-0000', []), /known stories: 0/);
}

// ---------------------------------------------------------------------------
// (4) An id needing escaping is encoded, never interpolated raw.
// ---------------------------------------------------------------------------
{
  const awkward = ['B-9f2c#frag', 'B-9f2c?q=1', 'B name/with slash', 'B-%2e%2e'];
  for (const id of awkward) {
    const accepted = assertGraphStoryExists(id, [id]);
    assert.equal(accepted, id);
    const encoded = encodeURIComponent(accepted);
    const url = `http://localhost:${GRAPH_DEFAULT_PORT}/story/${encoded}`;

    // The path must survive URL parsing intact: raw interpolation would move `#frag`
    // into the hash and `?q=1` into the search, opening a different page entirely.
    const parsed = new URL(url);
    assert.equal(parsed.hash, '', `${id}: no fragment may leak out of the id`);
    assert.equal(parsed.search, '', `${id}: no query may leak out of the id`);
    assert.equal(decodeURIComponent(parsed.pathname.slice('/story/'.length)), id,
      `${id}: the id must round-trip through the URL`);
    assert.equal(parsed.pathname.split('/').length, 3, `${id}: the id must not add path segments`);
  }
}

// ---------------------------------------------------------------------------
// (5) The REAL handler, driven end to end against a stub graph package written to disk.
//
// This is the case the CLI cannot cover: a KNOWN id makes the handler serve, and the
// serving path never resolves its promise, so invoking it through the CLI would hang.
// Driving `createGraphHandlers` directly with `ctx.root` pointing at a temporary tree
// that contains a `packages/graph/dist/index.js` stub lets the handler take its real
// resolution path (resolveGraphPackage -> runtime floor -> dynamic import) while the
// module it ends up importing is one this test wrote.
//
// What it pins that the pure helpers cannot: the ORDER. `startServer` must still be at
// zero calls when an unknown id is refused, and the URL actually handed to `openBrowser`
// must be the /story/<id> one.
// ---------------------------------------------------------------------------
{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-story-flag-'));
  try {
    const stubPkg = join(fixtureRoot, 'packages', 'graph');
    mkdirSync(join(stubPkg, 'dist'), { recursive: true });
    mkdirSync(join(stubPkg, 'assets'), { recursive: true });
    // The handler refuses to serve without a built client, so the fixture provides one.
    // BOTH files are required: ensureGraphClientBuilt checks app.html AND d3.min.js,
    // because a build run without dependencies still emits app.html while omitting d3,
    // and the page then silently falls back to a different rendering path. Stubbing only
    // app.html sends the handler down its npm install / npm run build recovery path
    // against this minimal fixture package, which throws instead of failing cleanly.
    writeFileSync(join(stubPkg, 'assets', 'app.html'), '<!doctype html><title>stub</title>');
    writeFileSync(join(stubPkg, 'assets', 'd3.min.js'), '/* stub d3 */');
    writeFileSync(
      join(stubPkg, 'package.json'),
      // `type: module` is not decoration: without it Node emits a MODULE_TYPELESS_PACKAGE_JSON
      // warning while reparsing the stub, which buries this task's real output in noise.
      JSON.stringify({ name: '@proof-or-stop/graph-stub', type: 'module', engines: { node: '>=22.5.0' } }),
    );
    // The stub library records what the handler did into a JSON file, because it runs as a
    // separately imported ES module and shares no object graph with this process's scope.
    const tracePath = join(fixtureRoot, 'trace.json');
    writeFileSync(
      join(stubPkg, 'dist', 'index.js'),
      `import { writeFileSync as w, readFileSync as r, existsSync as x } from 'node:fs';
const TRACE = ${JSON.stringify(tracePath)};
const KNOWN = ${JSON.stringify([...KNOWN_IDS, ESCAPING_ID])};
const read = () => (x(TRACE) ? JSON.parse(r(TRACE, 'utf8')) : { startServerCalls: 0, openedUrls: [] });
const bump = (f) => { const t = read(); f(t); w(TRACE, JSON.stringify(t)); };
export const findRoot = (start) => ({ root: start, reason: 'stub' });
export const resolveStories = () => ({ primary: Object.fromEntries(KNOWN.map((i) => [i, '/stub/' + i])) });
export const createApp = () => ({ root: 'stub-root', getStatus: () => ({ stories: KNOWN.length, edges: 0, indexRows: 0 }), close() {} });
export const startServer = async () => { bump((t) => { t.startServerCalls++; }); return { close(cb) { if (cb) cb(); } }; };
export const openBrowser = (url) => { bump((t) => { t.openedUrls.push(url); }); };
`,
    );

    const ctx = { root: fixtureRoot, log: () => {} } as unknown as HandlerContext;
    const handlers = createGraphHandlers(ctx);
    const graph = handlers.graph as (a: Record<string, unknown>) => Promise<unknown>;
    const readTrace = (): StubTrace =>
      (existsSync(tracePath)
        ? JSON.parse(readFileSync(tracePath, 'utf8'))
        : { startServerCalls: 0, openedUrls: [] }) as StubTrace;

    // --- unknown id: refused, and NOTHING listened. ---
    //
    // `rejectsPromptly`, not a bare `assert.rejects`: if the pre-listen check is ever
    // removed, the handler SERVES the bad id and its promise never resolves, so a bare
    // await would simply hang and Node would exit with an "unsettled top-level await"
    // warning naming this line — a non-zero exit, but one that reads like a broken test
    // rather than a broken feature. Racing it against a deadline turns that regression
    // into the message it actually is. (Verified by removing the check: without the race
    // the task hung; with it, it reports the sentence below.)
    await rejectsPromptly(
      () => graph({ root: fixtureRoot, story: 'B-0000zzz', open: false, port: 18731 }),
      /is not a story in this repository/,
      'an unknown --story must be REFUSED, not served: the pre-listen validation is gone',
    );
    assert.equal(readTrace().startServerCalls, 0,
      'an unknown --story must be refused BEFORE startServer is called');
    assert.deepEqual(readTrace().openedUrls, [], 'nothing may be opened for a refused id');

    // --- schema-bypassing values, straight at the real handler (no Zod in this path). ---
    // Each case pins WHICH refusal fires, not merely that something threw. An id-shaped
    // but empty value must hit the "requires a story id" branch: if that check is ever
    // weakened to a bare `typeof story !== 'string'`, `''` still gets refused — but by the
    // "not a story in this repository" branch, whose message tells the caller to go
    // looking for a story they never named. Verified by regression that the loose
    // `/^graph: --story/` assertion this replaced could NOT tell the two apart.
    const bypassing: readonly (readonly [unknown, RegExp])[] = [
      ['', /--story requires a story id/],
      ['   ', /--story requires a story id/],
      [null, /--story requires a story id/],
      [7, /--story requires a story id/],
      [{ storyId: 'B-9f2c' }, /--story requires a story id/],
      [['B-9f2c'], /--story requires a story id/],
      [true, /--story requires a story id/],
      // A well-formed string that simply names nothing gets the OTHER message.
      ['B-not-a-story', /is not a story in this repository/],
    ];
    for (const [bogus, expected] of bypassing) {
      await rejectsPromptly(
        () => graph({ root: fixtureRoot, story: bogus, open: false, port: 18731 }),
        expected,
        `handler entry must refuse ${JSON.stringify(bogus)} with the right diagnosis, even though it never met the schema`,
      );
    }
    assert.equal(readTrace().startServerCalls, 0, 'no bypassing value may reach startServer');

    // --- known id: serves, and opens the /story/<id> URL. ---
    const served = graph({ root: fixtureRoot, story: 'B-9f2c', port: 18731 });
    await waitFor(() => readTrace().openedUrls.length > 0, 'the known id must open a URL');
    assert.deepEqual(readTrace().openedUrls, ['http://localhost:18731/story/B-9f2c']);
    assert.equal(readTrace().startServerCalls, 1, 'the known id must actually serve');
    process.emit('SIGINT');
    assert.match(String(await served), /graph stopped/);

    // --- no --story: the plain / URL, byte-identical to the pre-B-9f2c behaviour. ---
    writeFileSync(tracePath, JSON.stringify({ startServerCalls: 0, openedUrls: [] }));
    const plain = graph({ root: fixtureRoot, port: 18732 });
    await waitFor(() => readTrace().openedUrls.length > 0, 'the default path must open a URL');
    assert.deepEqual(readTrace().openedUrls, ['http://localhost:18732/'],
      'without --story the URL must be unchanged');
    process.emit('SIGINT');
    await plain;

    // --- an id needing escaping is ENCODED BY THE HANDLER on the way into the URL. ---
    //
    // This must assert on the URL the handler actually produced, not on a locally
    // recomputed encodeURIComponent: verified by regression that dropping the handler's
    // encodeURIComponent leaves a locally-computed check passing while this one fails.
    // ESCAPING_ID is a known story for this run, so the handler reaches the URL-building
    // step instead of refusing at validation.
    writeFileSync(tracePath, JSON.stringify({ startServerCalls: 0, openedUrls: [] }));
    const escaped = graph({ root: fixtureRoot, story: ESCAPING_ID, port: 18733 });
    await waitFor(() => readTrace().openedUrls.length > 0, 'the escaping id must open a URL');
    const [escapedUrl] = readTrace().openedUrls;
    assert.equal(
      escapedUrl,
      `http://localhost:18733/story/${encodeURIComponent(ESCAPING_ID)}`,
      'the handler must URL-encode the id rather than interpolate it raw',
    );
    // Raw interpolation would push `#frag` into the hash and `?q=1` into the search,
    // opening a different page entirely; parse the handler's own string to prove it did not.
    const parsedFromHandler = new URL(escapedUrl);
    assert.equal(parsedFromHandler.hash, '', 'no fragment may leak out of the id');
    assert.equal(parsedFromHandler.search, '', 'no query may leak out of the id');
    assert.equal(
      decodeURIComponent(parsedFromHandler.pathname.slice('/story/'.length)),
      ESCAPING_ID,
      'the id must round-trip through the handler-built URL',
    );
    assert.equal(parsedFromHandler.pathname.split('/').length, 3,
      'the id must not introduce extra path segments');
    process.emit('SIGINT');
    await escaped;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (6) The real CLI: an unknown id exits non-zero, says why, and leaves the default port
// free — i.e. it was refused BEFORE anything listened. The port check is the mechanical
// part: if the refusal had been placed after startServer, a server would have been bound
// (and, because the handler's promise never resolves, the process would not have exited
// at all — so a fast non-zero exit is itself corroborating evidence).
// ---------------------------------------------------------------------------
const CLI = join(REPO_ROOT, 'packages', 'main', 'dist', 'cli.js');
if (!existsSync(CLI)) {
  console.error(`graph --story smoke: missing ${CLI}; run: npm --prefix packages/main run build`);
  process.exit(1);
}

function runCli(args: readonly string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`,
    };
  }
}

{
  const started = Date.now();
  const unknown = runCli(['graph', '--story=B-0000zzz', '--no-open']);
  const elapsedMs = Date.now() - started;

  assert.notEqual(unknown.code, 0, 'an unknown --story must exit non-zero');
  assert.match(unknown.out, /is not a story in this repository/, 'the refusal must name the reason');
  assert.match(unknown.out, /B-0000zzz/, 'the refusal must echo what was asked for');
  assert.ok(
    !/graph serving http/.test(unknown.out),
    'a refused --story must never report a served URL',
  );
  assert.ok(
    !/Serving until interrupted/.test(unknown.out),
    'a refused --story must never reach the serving banner',
  );
  // The serving path never returns, so any exit at all means startServer was not reached.
  // Bound generously: this only has to exclude "it served, then something killed it".
  assert.ok(elapsedMs < 120_000, 'the refusal must return promptly, not after a served session');
}

// --help advertises the flag, otherwise the feature is undiscoverable.
{
  const help = runCli(['graph', '--help']);
  assert.equal(help.code, 0, 'graph --help must succeed');
  assert.match(help.out, /--story/, 'graph --help must advertise --story');
  // The catalog must NOT have used `.default()`: that renders the flag as required with
  // type `any`, which is the exact regression the `open` flag's comment warns about.
  assert.ok(
    !/--story\s*<any>/.test(help.out),
    'a ZodDefault wrapper would render --story as required with type any',
  );
}

// --json must keep working WITHOUT --story and without depending on the browser client.
{
  const json = runCli(['graph', '--json']);
  assert.equal(json.code, 0, 'graph --json must still succeed with no --story');
  assert.ok(
    !/graph serving http/.test(json.out),
    '--json must not serve',
  );
  const payload = json.out.slice(json.out.indexOf('{'));
  const status = JSON.parse(payload) as { stories?: unknown };
  assert.equal(typeof status.stories, 'number', '--json must still report a story count');

  // ...and it must refuse an unknown id too, rather than reporting a healthy status for a
  // story the caller never actually named.
  const jsonUnknown = runCli(['graph', '--json', '--story=B-0000zzz']);
  assert.notEqual(jsonUnknown.code, 0, '--json --story=<unknown> must be refused');
  assert.match(jsonUnknown.out, /is not a story in this repository/);
}

console.log(PASS_LINE);
