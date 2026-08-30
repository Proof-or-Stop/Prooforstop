/**
 * verifier/browser-executor: Browser integration test executor
 *
 * Architecture:
 *   Browser <-> Proxy(:proxyPort) <-> dev server(:devPort)
 *                 | intercepts HTML, injects client.js
 *   client.js <-WS-> bridge(:wsPort) <-HTTP-> executor(:httpPort)
 *
 * Browser integration test executor.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _onProgress: ((msg: string) => void) | null = null;
function log(msg: string) {
  if (_onProgress) _onProgress(msg);
}

/** Generate deterministic port from project path */
export function stablePort(projectRoot: string, offset: number): number {
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
  }
  return 10000 + (Math.abs(hash + offset * 7919) % 50000);
}

export interface BrowserStep {
  action: 'click' | 'eval' | 'assert' | 'screenshot' | 'wait' | 'type';
  selector?: string;
  x?: number;
  y?: number;
  code?: string;
  contains?: string;
  text?: string;
  ms?: number;
  saveTo?: string;
}

export interface BrowserCaseResult {
  name: string;
  passed: boolean;
  steps: Array<{ action: string; passed: boolean; error?: string; result?: unknown }>;
  screenshotPaths: string[];
  durationMs: number;
}

export interface BrowserTestResult {
  cases: BrowserCaseResult[];
}

export interface BrowserTestConfig {
  devCommand: string;
  projectRoot: string;
  httpPort?: number;
  proxyPort?: number;
  assertTimeout?: number;
  assertInterval?: number;
  screenshotDir?: string;
  /** Progress callback */
  onProgress?: (msg: string) => void;
  /** Pattern to detect dev server ready */
  serverReadyPattern?: string;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Load compiled browser-client.js */
function loadClientScript(): string {
  const candidates = [
    join(__dirname, 'browser-client.js'),
    join(__dirname, '..', 'browser-client.js'),
    join(__dirname, '..', '..', 'dist', 'browser-client.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    }
  }
  throw new Error('browser-client.js not found: ' + candidates.join(', '));
}

/** Start HTML injection proxy */
function startProxy(
  devUrl: string, proxyPort: number, clientScript: string, wsPort: number,
): Promise<{ server: ReturnType<typeof createServer>; close: () => void }> {
  return new Promise((resolve) => {
    const devOrigin = new URL(devUrl);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';

      try {
        const resp = await fetch(`${devOrigin.origin}${url}`, {
          method: req.method,
          headers: { 'Accept': req.headers.accept || '*/*' },
        });

        const contentType = resp.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
          let html = await resp.text();
          const injection = `<script>window.__PROOF_OR_STOP_WS_PORT=${wsPort};${clientScript}</script>`;
          if (html.includes('</head>')) {
            html = html.replace('</head>', `${injection}</head>`);
          } else {
            html = injection + html;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } else {
          const body = Buffer.from(await resp.arrayBuffer());
          const headers: Record<string, string> = {};
          resp.headers.forEach((v, k) => { headers[k] = v; });
          delete headers['content-encoding'];
          res.writeHead(resp.status, headers);
          res.end(body);
        }
      } catch (e: any) {
        res.writeHead(502);
        res.end(`Proxy error: ${e.message}`);
      }
    });

    // WS upgrade: forward to dev server
    server.on('upgrade', (req, socket, head) => {
      const devSocket = net.connect(Number(devOrigin.port) || 80, devOrigin.hostname, () => {
        devSocket.write(
          `GET ${req.url || '/'} HTTP/1.1\r\nHost: ${devOrigin.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\nSec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n\r\n`
        );
        devSocket.write(head);
        devSocket.pipe(socket);
        socket.pipe(devSocket);
      });
      devSocket.on('error', () => socket.destroy());
    });

    server.listen(proxyPort, () => {
      resolve({ server, close: () => server.close() });
    });
  });
}

/** HTTP request to bridge API */
async function api(port: number, path: string, body?: unknown, method?: string): Promise<any> {
  const url = `http://localhost:${port}${path}`;
  const opts: RequestInit = { method: method || (body ? 'POST' : 'GET') };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (path === '/screenshot' && res.headers.get('content-type')?.includes('image')) {
    return { ok: true, data: Buffer.from(await res.arrayBuffer()) };
  }
  return res.json();
}

async function waitForBrowser(port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await api(port, '/status');
      if (status.connected) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Browser did not connect within timeout');
}

function startProcess(command: string, cwd: string): ChildProcess {
  const [cmd, ...args] = command.split(' ');
  return spawn(cmd, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Kill process tree + cleanup pipes */
function killProcess(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  try { child.stdout?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
  try { child.stdin?.destroy(); } catch {}
}

function waitForServerReady(child: ChildProcess, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dev server did not start within timeout')), timeoutMs);
    let output = '';
    const onData = (data: Buffer) => {
      output += stripAnsi(data.toString());
      const urlMatch = output.match(/https?:\/\/[\w.\-]+:\d+/);
      if (urlMatch) { clearTimeout(timer); resolve(urlMatch[0].replace(/127\.0\.0\.1|0\.0\.0\.0/, 'localhost')); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`Process exited with code ${code}`)); } });
  });
}

function waitForHttpReady(port: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge server did not start within timeout')), timeoutMs);
    const check = async () => {
      try {
        await fetch(`http://localhost:${port}/status`);
        clearTimeout(timer);
        resolve();
      } catch {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

function findBrowserServer(): string {
  const candidates = [
    join(__dirname, 'browser-server.js'),
    join(__dirname, '..', 'browser-server.js'),
    join(__dirname, '..', '..', 'dist', 'browser-server.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('browser-server.js not found: ' + candidates.join(', '));
}

async function executeStep(
  port: number, step: BrowserStep, screenshotDir: string,
  assertTimeout = 3000, assertInterval = 50,
): Promise<{ passed: boolean; error?: string; result?: unknown; screenshotPath?: string }> {
  switch (step.action) {
    case 'wait':
      await new Promise(r => setTimeout(r, step.ms || 1000));
      return { passed: true };

    case 'eval': {
      const r = await api(port, '/eval', { code: step.code });
      return { passed: r.ok !== false, result: r.result, error: r.error };
    }

    case 'click': {
      const body: Record<string, unknown> = {};
      if (step.selector) body.selector = step.selector;
      if (step.x !== undefined) body.x = step.x;
      if (step.y !== undefined) body.y = step.y;
      const r = await api(port, '/click', body);
      return { passed: r.ok !== false, error: r.error };
    }

    case 'type': {
      const r = await api(port, '/type', { selector: step.selector, text: step.text });
      return { passed: r.ok !== false, error: r.error };
    }

    case 'assert': {
      const code = step.selector
        ? `document.querySelector('${step.selector}')?.textContent || ''`
        : `document.body.textContent || ''`;
      const timeout = step.ms || assertTimeout;
      const deadline = Date.now() + timeout;
      let lastText = '';
      while (Date.now() < deadline) {
        const r = await api(port, '/eval', { code });
        if (!r.ok) return { passed: false, error: r.error };
        lastText = String(r.result || '');
        if (!step.contains || lastText.includes(step.contains)) {
          return { passed: true, result: lastText };
        }
        await new Promise(r => setTimeout(r, assertInterval));
      }
      return { passed: false, error: `Expected "${step.contains}" in "${lastText.slice(0, 100)}" (timeout ${timeout}ms)` };
    }

    case 'screenshot': {
      const r = await api(port, '/screenshot', undefined, 'POST');
      if (r.ok && r.data) {
        const filename = step.saveTo || `screenshot-${Date.now()}.png`;
        const filepath = join(screenshotDir, filename);
        mkdirSync(screenshotDir, { recursive: true });
        writeFileSync(filepath, r.data);
        return { passed: true, screenshotPath: filepath };
      }
      return { passed: false, error: r.error || 'screenshot failed' };
    }

    default:
      return { passed: false, error: `Unknown action: ${step.action}` };
  }
}

/** Per-project persistent processes (bridge + dev + proxy), reused across test runs */
interface ProjectEnv {
  bridgeProcess: ChildProcess;
  devProcess: ChildProcess;
  proxy: { close: () => void };
  httpPort: number;
  proxyPort: number;
  devUrl: string;
  projectRoot: string;
}

const _envCache = new Map<string, ProjectEnv>();

function isAlive(proc: ChildProcess): boolean {
  try {
    if (!proc.pid) return false;
    if (proc.exitCode !== null) return false;
    return true;
  } catch { return false; }
}

async function isEnvHealthy(env: ProjectEnv): Promise<boolean> {
  if (!isAlive(env.bridgeProcess) || !isAlive(env.devProcess)) return false;
  try {
    const status = await api(env.httpPort, '/status');
    return !!status;
  } catch { return false; }
}

function cleanupEnv(env: ProjectEnv) {
  try { env.proxy.close(); } catch {}
  killProcess(env.devProcess);
  killProcess(env.bridgeProcess);
  env.devProcess.removeAllListeners();
  env.bridgeProcess.removeAllListeners();
}

/** Manually cleanup persistent processes for a project or all projects */
export function cleanupBrowserEnv(projectRoot?: string) {
  if (projectRoot) {
    const env = _envCache.get(projectRoot);
    if (env) { cleanupEnv(env); _envCache.delete(projectRoot); }
  } else {
    for (const [key, env] of _envCache) { cleanupEnv(env); _envCache.delete(key); }
  }
}

process.on('exit', () => cleanupBrowserEnv());

export async function executeBrowserCases(
  config: BrowserTestConfig,
  cases: Array<{ name: string; steps: BrowserStep[] }>,
): Promise<BrowserTestResult> {
  const screenshotDir = config.screenshotDir || join(config.projectRoot, 'tests', 'screenshots');
  const results: BrowserCaseResult[] = [];

  _onProgress = config.onProgress || null;
  log(`browser-test start: ${cases.length} cases`);

  // Reuse or create project environment
  let env = _envCache.get(config.projectRoot);
  if (env) {
    const healthy = await isEnvHealthy(env);
    if (healthy) {
      log('reusing existing environment (bridge + dev + proxy)');
    } else {
      log('cached environment is dead, cleaning up');
      cleanupEnv(env);
      _envCache.delete(config.projectRoot);
      env = undefined;
    }
  }

  if (!env) {
    // Deterministic ports
    const wsPort = stablePort(config.projectRoot, 0);
    const actualHttpPort = stablePort(config.projectRoot, 1);
    const actualProxyPort = stablePort(config.projectRoot, 2);
    log(`ports: ws=${wsPort} http=${actualHttpPort} proxy=${actualProxyPort}`);

    // 1. Start bridge server (WS + HTTP API)
    const serverPath = findBrowserServer();
    log(`starting bridge: ${serverPath}`);
    const bridgeProcess = spawn('node', [serverPath], {
      cwd: config.projectRoot, shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WS_PORT: String(wsPort), HTTP_PORT: String(actualHttpPort) },
    });
    bridgeProcess.stderr?.on('data', (d: Buffer) => log(`bridge: ${stripAnsi(d.toString().trim())}`));
    bridgeProcess.stdout?.on('data', (d: Buffer) => log(`bridge: ${stripAnsi(d.toString().trim())}`));

    // 2. Start dev server
    log(`starting dev server: ${config.devCommand}`);
    const devProcess = startProcess(config.devCommand, config.projectRoot);

    await waitForHttpReady(actualHttpPort);
    log('bridge ready');

    const devUrl = await waitForServerReady(devProcess);
    log(`dev server ready: ${devUrl}`);

    // 3. Start proxy with HTML injection
    const clientScript = loadClientScript();
    log(`loaded client script (${clientScript.length} chars)`);
    const proxyResult = await startProxy(devUrl, actualProxyPort, clientScript, wsPort);
    log(`proxy ready on :${actualProxyPort} -> ${devUrl}`);

    env = { bridgeProcess, devProcess, proxy: proxyResult, httpPort: actualHttpPort, proxyPort: actualProxyPort, devUrl, projectRoot: config.projectRoot };
    _envCache.set(config.projectRoot, env);
  }

  try {
    // 4. Browser reuse: wait for old tab reconnection
    const proxyUrl = `http://localhost:${env.proxyPort}`;
    let browserReused = false;

    for (let i = 0; i < 6; i++) {
      try {
        const status = await api(env.httpPort, '/status');
        if (status.connected) {
          log('browser reconnected, force reloading...');
          await api(env.httpPort, '/eval', { code: `location.href = '${proxyUrl}?_t=${Date.now()}'` });
          await new Promise(r => setTimeout(r, 1000));
          await waitForBrowser(env.httpPort);
          log('browser reloaded and reconnected');
          browserReused = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    if (!browserReused) {
      const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(openCmd, [proxyUrl], { shell: true, stdio: 'ignore', detached: true }).unref();
      log('browser opening new tab...');
    }

    // 5. Wait for browser connection
    await waitForBrowser(env.httpPort);
    log('browser connected');

    // 6. Execute cases
    for (const c of cases) {
      log(`case: "${c.name}" (${c.steps.length} steps)`);
      const startCase = Date.now();
      const stepResults: BrowserCaseResult['steps'] = [];
      const screenshotPaths: string[] = [];
      let allPassed = true;

      for (let i = 0; i < c.steps.length; i++) {
        const step = c.steps[i];
        const r = await executeStep(env.httpPort, step, screenshotDir, config.assertTimeout || 3000, config.assertInterval || 50);
        log(`  step ${i + 1}/${c.steps.length} ${step.action}: ${r.passed ? 'PASS' : 'FAIL'}${r.error ? ' -- ' + r.error : ''}`);
        stepResults.push({ action: step.action, passed: r.passed, error: r.error, result: r.result });
        if (r.screenshotPath) screenshotPaths.push(r.screenshotPath);
        if (!r.passed) { allPassed = false; break; }
      }

      const caseMs = Date.now() - startCase;
      log(`case "${c.name}": ${allPassed ? 'PASS' : 'FAIL'} (${caseMs}ms)`);
      results.push({ name: c.name, passed: allPassed, steps: stepResults, screenshotPaths, durationMs: caseMs });
    }

  } catch (e) {
    log(`error during test execution: ${e}`);
    cleanupEnv(env);
    _envCache.delete(config.projectRoot);
    throw e;
  }

  log(`done: ${results.filter(r => r.passed).length}/${results.length} passed`);
  return { cases: results };
}
