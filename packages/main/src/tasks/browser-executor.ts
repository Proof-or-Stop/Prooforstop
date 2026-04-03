/**
 * browser-executor: 浏览器真机测试执行器
 *
 * 架构：
 *   浏览器 ←→ 代理(:proxyPort) ←→ dev server(:devPort)
 *                ↓ 拦截 HTML，注入 client.js
 *   client.js ←WS→ bridge(:9876) ←HTTP→ executor(:9877)
 *
 * 项目不需要改任何代码。只需配置 devCommand。
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _onProgress: ((msg: string) => void) | null = null;
function log(msg: string) {
  if (_onProgress) _onProgress(msg);
}

const DEFAULT_HTTP_PORT = 9877;
const DEFAULT_PROXY_PORT = 5174;

/** 根据项目路径生成确定性端口（同项目永远同端口，旧 tab 可重连） */
function stablePort(projectRoot: string, offset: number): number {
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
  }
  // 映射到 10000-60000 范围
  return 10000 + (Math.abs(hash + offset * 7919) % 50000);
}

export interface BrowserStep {
  action: 'click' | 'eval' | 'assert' | 'screenshot' | 'wait' | 'type' | 'call' | 'trace';
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
  /** 运行时 trace：被调用的函数列表 */
  trace: Array<{ fn: string; file: string }>;
  /** trace 覆盖的唯一函数名集合 */
  coveredFunctions: string[];
}

export interface BrowserTestConfig {
  devCommand: string;
  projectRoot: string;
  httpPort?: number;
  proxyPort?: number;
  assertTimeout?: number;
  assertInterval?: number;
  screenshotDir?: string;
  /** 进度回调：每个阶段/步骤完成时调用，实现流式输出 */
  onProgress?: (msg: string) => void;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** 读取编译后的 browser-client.js */
function loadClientScript(): string {
  const candidates = [
    join(__dirname, 'browser-client.js'),
    join(__dirname, '..', '..', 'dist', 'tasks', 'browser-client.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      // 去掉 ESM export 语句，浏览器 <script> 标签不支持
      return readFileSync(p, 'utf-8')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    }
  }
  throw new Error('browser-client.js not found: ' + candidates.join(', '));
}

interface TrackedModule {
  sourceFile: string;  // e.g. "src/game-logic.ts"
  functions: string[]; // e.g. ["createGame", "checkWin", "place", "undo"]
}

/** 从 task.json 读取需要追踪的模块和函数 */
function loadTrackedModules(projectRoot: string): TrackedModule[] {
  const taskPath = join(projectRoot, 'docs', 'metadata', 'task.json');
  if (!existsSync(taskPath)) return [];
  try {
    const store = JSON.parse(readFileSync(taskPath, 'utf-8'));
    const byFile = new Map<string, string[]>();
    for (const t of store.tasks || []) {
      if (!t.functionName || !t.sourceFile) continue;
      const fns = byFile.get(t.sourceFile) || [];
      fns.push(t.functionName);
      byFile.set(t.sourceFile, fns);
    }
    return Array.from(byFile.entries()).map(([sourceFile, functions]) => ({ sourceFile, functions }));
  } catch { return []; }
}

/** 在 JS 源码中注入 trace：对所有有花括号的函数在 { 后插入 trace 代码 */
function wrapExportsWithTrace(js: string, mod: TrackedModule): string {
  const file = mod.sourceFile;

  // 通用匹配：所有 function name(...) { 和 name(...) { 和 name = (...) => {
  // 捕获函数名用于 trace
  let result = js;

  const traceCode = (name: string) =>
    `if(typeof window!=='undefined'&&window.__trace){try{var __a=[...arguments].map(a=>{try{return JSON.parse(JSON.stringify(a))}catch{return'[unserializable]'}});window.__trace.push({fn:'${name}',file:'${file}',time:Date.now(),args:__a});}catch{window.__trace.push({fn:'${name}',file:'${file}',time:Date.now()});}}`;

  // 方式1: [export] [async] function name(...) {
  result = result.replace(
    /((?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{)/g,
    (_m, full, name) => `${full}${traceCode(name)}`
  );

  // 方式2: const/let/var name = [async] (...) => {
  result = result.replace(
    /((?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{)/g,
    (_m, full, name) => `${full}${traceCode(name)}`
  );

  // 方式3: 类方法 — [static] [async] [get/set] methodName(...) { (不含 function 关键字)
  // 排除已被方式1匹配的 function 声明，和控制流语句
  const controlFlow = new Set(['if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'typeof', 'instanceof', 'delete', 'void', 'in', 'of']);
  result = result.replace(
    /((?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{)/g,
    (m, full, name, matchOffset) => {
      // 跳过控制流关键字
      if (controlFlow.has(name)) return m;
      // 跳过已有 function 关键字的（已被方式1处理，避免重复注入）
      const before = result.slice(Math.max(0, matchOffset - 30), matchOffset);
      if (/function\s*$/.test(before)) return m;
      // 跳过已被方式2匹配的箭头函数（=>\s*{ 前面的部分）
      if (/=>\s*$/.test(before)) return m;
      return `${full}${traceCode(name)}`;
    }
  );

  // 末尾追加 __koala_modules 注册（用于 call action）
  const moduleRegistrations = mod.functions.map(fn =>
    `if(typeof ${fn}==='function')window.__koala_modules['${mod.sourceFile}'].${fn}=${fn};`
  ).join('\n');

  const suffix = `
;if(typeof window!=='undefined'){
  window.__trace=window.__trace||[];
  window.__koala_modules=window.__koala_modules||{};
  window.__koala_modules['${mod.sourceFile}']={};
  ${moduleRegistrations}
}
`;

  // __trace 初始化放在文件开头，确保模块执行时就有
  const prefix = `;if(typeof window!=='undefined'){window.__trace=window.__trace||[];}\n`;
  return prefix + result + suffix;
}

/** 启动 HTML 注入 + JS tracing 代理 */
function startProxy(
  devUrl: string, proxyPort: number, clientScript: string, trackedModules: TrackedModule[], wsPort: number,
): Promise<{ server: ReturnType<typeof createServer>; close: () => void }> {
  return new Promise((resolve) => {
    const devOrigin = new URL(devUrl);

    // 建立 URL 路径 → TrackedModule 的映射
    const moduleMap = new Map<string, TrackedModule>();
    for (const mod of trackedModules) {
      // vite 请求路径格式：/src/game-logic.ts
      moduleMap.set('/' + mod.sourceFile, mod);
    }

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';
      const cleanUrl = url.split('?')[0]; // 去掉查询参数

      try {
        const resp = await fetch(`${devOrigin.origin}${url}`, {
          method: req.method,
          headers: { 'Accept': req.headers.accept || '*/*' },
        });

        const contentType = resp.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
          // HTML：注入 WS 端口 + client.js
          let html = await resp.text();
          const injection = `<script>window.__KOALA_WS_PORT=${wsPort};${clientScript}</script>`;
          if (html.includes('</head>')) {
            html = html.replace('</head>', `${injection}</head>`);
          } else {
            html = injection + html;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } else if (contentType.includes('javascript') && moduleMap.has(cleanUrl)) {
          // 需要追踪的 JS 文件：追加 tracing 注册代码
          const js = await resp.text();
          const mod = moduleMap.get(cleanUrl)!;
          const wrapped = wrapExportsWithTrace(js, mod);
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(wrapped);
        } else {
          // 其他请求：透传
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

    // WS 升级：透传给 dev server
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

/** HTTP 请求 bridge API */
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

/** kill 整个进程树 + 清理 pipe */
function killProcess(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  // 清理 pipe，防止阻止 Node 退出
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
    join(__dirname, '..', 'tasks', 'browser-server.js'),
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

    case 'call': {
      // 调用 __koala_modules 里的函数
      const fn = step.code || ''; // fn name
      const args = step.text ? JSON.parse(step.text) : []; // args as JSON array
      const code = `(() => {
        const mods = window.__koala_modules || {};
        for (const [file, mod] of Object.entries(mods)) {
          if (typeof mod['${fn}'] === 'function') {
            const result = mod['${fn}'](...${JSON.stringify(args)});
            return JSON.parse(JSON.stringify(result));
          }
        }
        return { __error: 'function ${fn} not found in __koala_modules' };
      })()`;
      const r = await api(port, '/eval', { code });
      if (r.result?.__error) return { passed: false, error: r.result.__error };
      return { passed: r.ok !== false, result: r.result, error: r.error };
    }

    case 'trace': {
      // 获取调用链
      const code = 'JSON.parse(JSON.stringify(window.__trace || []))';
      const r = await api(port, '/eval', { code });
      if (!r.ok) return { passed: false, error: r.error };
      return { passed: true, result: r.result };
    }

    default:
      return { passed: false, error: `Unknown action: ${step.action}` };
  }
}

/** 每个项目的常驻进程（bridge + dev + proxy），跨测试运行复用 */
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

/** 检查进程是否还活着 */
function isAlive(proc: ChildProcess): boolean {
  try {
    if (!proc.pid) return false;
    // exitCode 非 null 说明已退出
    if (proc.exitCode !== null) return false;
    return true;
  } catch { return false; }
}

/** 检查缓存的环境是否可用 */
async function isEnvHealthy(env: ProjectEnv): Promise<boolean> {
  if (!isAlive(env.bridgeProcess) || !isAlive(env.devProcess)) return false;
  try {
    const status = await api(env.httpPort, '/status');
    return !!status; // bridge 响应即可
  } catch { return false; }
}

/** 清理项目环境（同步强杀，不等待） */
function cleanupEnv(env: ProjectEnv) {
  try { env.proxy.close(); } catch {}
  killProcess(env.devProcess);
  killProcess(env.bridgeProcess);
  // 清除所有 listener 防止残留 handle
  env.devProcess.removeAllListeners();
  env.bridgeProcess.removeAllListeners();
}

/** 手动清理指定项目或所有项目的常驻进程 */
export function cleanupBrowserEnv(projectRoot?: string) {
  if (projectRoot) {
    const env = _envCache.get(projectRoot);
    if (env) { cleanupEnv(env); _envCache.delete(projectRoot); }
  } else {
    for (const [key, env] of _envCache) { cleanupEnv(env); _envCache.delete(key); }
  }
}

// 进程退出时清理所有常驻环境
process.on('exit', () => cleanupBrowserEnv());

export async function executeBrowserCases(
  config: BrowserTestConfig,
  cases: Array<{ name: string; steps: BrowserStep[] }>,
): Promise<BrowserTestResult> {
  const httpPort = config.httpPort || DEFAULT_HTTP_PORT;
  const proxyPort = config.proxyPort || DEFAULT_PROXY_PORT;
  const screenshotDir = config.screenshotDir || join(config.projectRoot, 'tests', 'screenshots');
  const results: BrowserCaseResult[] = [];

  _onProgress = config.onProgress || null;
  log(`browser-test start: ${cases.length} cases`);

  let trace: Array<{ fn: string; file: string }> = [];
  let coveredFunctions: string[] = [];

  // 复用或创建项目环境
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
    // 0. 确定性端口（同项目同端口，旧 tab 可重连）
    const wsPort = stablePort(config.projectRoot, 0);
    const actualHttpPort = stablePort(config.projectRoot, 1);
    const actualProxyPort = stablePort(config.projectRoot, 2);
    log(`ports: ws=${wsPort} http=${actualHttpPort} proxy=${actualProxyPort}`);

    // 清理旧进程（确定性端口，上次可能残留）
    if (process.platform === 'win32') {
      for (const port of [wsPort, actualHttpPort, actualProxyPort]) {
        try {
          const { execSync } = await import('child_process');
          const out = execSync(`netstat -ano | findstr :${port}.*LISTENING`, { encoding: 'utf-8', timeout: 3000 });
          const pids = new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
          for (const pid of pids) {
            if (pid && pid !== '0') {
              try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', timeout: 3000 }); } catch {}
              log(`killed residual on :${port} (PID ${pid})`);
            }
          }
        } catch { /* no process */ }
      }
    }

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

    // 3. Start proxy with HTML injection (传 wsPort 给 client.js)
    const clientScript = loadClientScript();
    const trackedModules = loadTrackedModules(config.projectRoot);
    log(`loaded client script (${clientScript.length} chars), tracking ${trackedModules.length} modules`);
    const proxyResult = await startProxy(devUrl, actualProxyPort, clientScript, trackedModules, wsPort);
    log(`proxy ready on :${actualProxyPort} → ${devUrl}`);

    env = { bridgeProcess, devProcess, proxy: proxyResult, httpPort: actualHttpPort, proxyPort: actualProxyPort, devUrl, projectRoot: config.projectRoot };
    _envCache.set(config.projectRoot, env);
  }

  try {
    // 4. 浏览器复用：等旧 tab 重连（确定性端口），否则开新页面
    const proxyUrl = `http://localhost:${env.proxyPort}`;
    let browserReused = false;

    // 先等 3 秒看旧 tab 是否自动重连
    for (let i = 0; i < 6; i++) {
      try {
        const status = await api(env.httpPort, '/status');
        if (status.connected) {
          log('browser reconnected, reloading...');
          await api(env.httpPort, '/eval', { code: `location.href = '${proxyUrl}'; void 0` });
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
        log(`  step ${i + 1}/${c.steps.length} ${step.action}: ${r.passed ? 'PASS' : 'FAIL'}${r.error ? ' — ' + r.error : ''}`);
        stepResults.push({ action: step.action, passed: r.passed, error: r.error, result: r.result });
        if (r.screenshotPath) screenshotPaths.push(r.screenshotPath);
        if (!r.passed) { allPassed = false; break; }
      }

      const caseMs = Date.now() - startCase;
      log(`case "${c.name}": ${allPassed ? 'PASS' : 'FAIL'} (${caseMs}ms)`);
      results.push({ name: c.name, passed: allPassed, steps: stepResults, screenshotPaths, durationMs: caseMs });
    }

    // 7. 收集 trace（浏览器端 JSON → gzip → base64，Node 端解压）
    try {
      const traceResult = await api(env.httpPort, '/eval', { code: `(async () => {
        const t = window.__trace || [];
        const json = JSON.stringify(t);
        // 压缩：CompressionStream API（浏览器原生）
        if (typeof CompressionStream !== 'undefined') {
          const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
          const compressed = await new Response(stream).arrayBuffer();
          const bytes = new Uint8Array(compressed);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return { compressed: true, data: btoa(binary), count: t.length };
        }
        // fallback：不压缩，直接返回
        return { compressed: false, data: json, count: t.length };
      })()` });
      if (traceResult.ok && traceResult.result) {
        const r = traceResult.result;
        let traceData: any[];
        if (r.compressed) {
          // Node 端解压：base64 → buffer → gunzip
          const { gunzipSync } = await import('zlib');
          const buf = Buffer.from(r.data, 'base64');
          const json = gunzipSync(buf).toString('utf-8');
          traceData = JSON.parse(json);
        } else {
          traceData = JSON.parse(r.data);
        }
        trace = traceData.map((t: any) => ({ fn: t.fn, file: t.file || '' }));
        coveredFunctions = [...new Set(traceData.map((t: any) => t.fn))];
        log(`trace: ${r.count} calls (${r.compressed ? 'gzip' : 'raw'}), ${coveredFunctions.length} unique functions: ${coveredFunctions.join(', ')}`);
      }
    } catch (e: any) {
      log(`trace collection failed: ${e.message}`);
    }

  } catch (e) {
    // 环境出错时清理缓存，下次重建
    log(`error during test execution: ${e}`);
    cleanupEnv(env);
    _envCache.delete(config.projectRoot);
    throw e;
  }
  // 注意：不在 finally 中清理 — 保留环境供下次复用

  log(`done: ${results.filter(r => r.passed).length}/${results.length} passed`);
  return { cases: results, trace, coveredFunctions };
}
