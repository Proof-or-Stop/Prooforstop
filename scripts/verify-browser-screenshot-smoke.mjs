#!/usr/bin/env node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const mode = process.argv[2] || 'smoke';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveBrowserExecutorModule() {
  const candidates = [
    join(__dirname, '..', 'packages', 'main', 'dist', 'tasks', 'browser-executor.js'),
    join(__dirname, '..', '..', 'packages', 'main', 'dist', 'tasks', 'browser-executor.js'),
    '/Users/jek/Documents/Work/Orchestrate/packages/main/dist/tasks/browser-executor.js',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`browser-executor.js not found: ${candidates.join(', ')}`);
}

function createTempProject(serverPort) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-browser-smoke-'));
  mkdirSync(join(dir, 'tests', 'screenshots'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"><title>ProofOrStop Browser Screenshot Smoke</title></head>',
    '<body>',
    '  <canvas id="board" width="160" height="120"></canvas>',
    '  <script>',
    '    const canvas = document.getElementById("board");',
    '    const ctx = canvas.getContext("2d");',
    '    ctx.fillStyle = "#f97316";',
    '    ctx.fillRect(0, 0, 160, 120);',
    '    ctx.fillStyle = "#0f172a";',
    '    ctx.font = "16px sans-serif";',
    '    ctx.fillText("proof-or-stop screenshot", 12, 62);',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'server.mjs'), [
    "import { createServer } from 'http';",
    "import { readFileSync } from 'fs';",
    "import { join } from 'path';",
    "const root = process.cwd();",
    `const port = Number(process.env.PORT || ${serverPort});`,
    "const html = readFileSync(join(root, 'index.html'), 'utf8');",
    'const server = createServer((req, res) => {',
    "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
    '  res.end(html);',
    '});',
    "server.listen(port, () => console.log(`http://localhost:${port}`));",
    "const shutdown = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    '',
  ].join('\n'));
  return dir;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSmoke(jsonMode = false) {
  const browserExecutor = await import(pathToFileURL(resolveBrowserExecutorModule()).href);
  const { executeBrowserCases, cleanupBrowserEnv } = browserExecutor;
  const port = 43117;
  const projectRoot = createTempProject(port);
  try {
    const screenshotDir = join(projectRoot, 'tests', 'screenshots');
    const result = await executeBrowserCases({
      devCommand: `PORT=${port} node server.mjs`,
      projectRoot,
      screenshotDir,
    }, [
      {
        name: 'browser screenshot smoke',
        steps: [
          { action: 'wait', ms: 300 },
          { action: 'screenshot', saveTo: 'smoke.png' },
        ],
      },
    ]);

    const caseResult = result.cases[0];
    assert(caseResult?.passed === true, `browser screenshot case failed: ${JSON.stringify(caseResult)}`);
    assert(caseResult.screenshotPaths.length === 1, 'expected exactly one screenshot path');
    const screenshotPath = caseResult.screenshotPaths[0];
    assert(existsSync(screenshotPath), `missing screenshot file: ${screenshotPath}`);
    assert(statSync(screenshotPath).size > 100, 'screenshot file is unexpectedly small');
    const pngHeader = readFileSync(screenshotPath).subarray(0, 8).toString('hex');
    assert(pngHeader === '89504e470d0a1a0a', 'screenshot is not a PNG file');

    const payload = {
      verified: true,
      strategy: 'canvas',
      screenshotCount: caseResult.screenshotPaths.length,
      screenshotBytes: statSync(screenshotPath).size,
    };
    if (jsonMode) console.log(JSON.stringify(payload));
    else console.log('browser screenshot smoke verified');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('Browser did not connect') ||
      message.includes('No browser connected') ||
      message.includes('Dev server did not start')
    ) {
      throw new Error(`browser environment unavailable: ${message}`);
    }
    throw error;
  } finally {
    cleanupBrowserEnv(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function runBrokenEnvProbe(jsonMode = false) {
  const browserExecutor = await import(pathToFileURL(resolveBrowserExecutorModule()).href);
  const { executeBrowserCases, cleanupBrowserEnv } = browserExecutor;
  const port = 43118;
  const projectRoot = createTempProject(port);
  try {
    let err = null;
    try {
      await withTimeout(
        executeBrowserCases({
          devCommand: `node -e "console.log('http://localhost:${port}')"` ,
          projectRoot,
          screenshotDir: join(projectRoot, 'tests', 'screenshots'),
        }, [
          {
            name: 'browser screenshot broken env',
            steps: [
              { action: 'wait', ms: 100 },
              { action: 'screenshot', saveTo: 'broken.png' },
            ],
          },
        ]),
        35000,
        'browser broken-env probe',
      );
    } catch (error) {
      err = error;
    }
    assert(err, 'expected broken environment probe to fail');
    const message = err instanceof Error ? err.message : String(err);
    assert(
      message.includes('Dev server did not start') ||
      message.includes('Browser did not connect') ||
      message.includes('No browser connected') ||
      message.includes('browser broken-env probe timed out'),
      `broken environment emitted unclear error: ${message}`,
    );
    const payload = {
      verified: true,
      category: 'browser-environment',
      message,
    };
    if (jsonMode) console.log(JSON.stringify(payload));
    else console.log('browser screenshot broken-env verified');
  } finally {
    cleanupBrowserEnv(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

try {
  if (mode === 'smoke') {
    await runSmoke(false);
  } else if (mode === 'smoke-json') {
    await runSmoke(true);
  } else if (mode === 'broken-env') {
    await runBrokenEnvProbe(false);
  } else if (mode === 'broken-env-json') {
    await runBrokenEnvProbe(true);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
