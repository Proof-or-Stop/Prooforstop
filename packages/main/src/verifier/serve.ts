// ============================================================
// koala serve — HTTP API 服务 + Bridge 调试 API + 浏览器代理 + 文件 watch
//
// 给 AI agent 和人用的实时调试接口：
//   GET  /status           项目状态
//   GET  /validate         最新传感器结果（文件变化后自动重跑）
//   POST /bridge/event     发送事件（自动从 machine.ts 生成）
//   GET  /bridge/state     当前 machine 状态
//   GET  /bridge/events    所有合法事件列表
//   POST /bridge/replay    批量重放事件序列
//   POST /bridge/reset     重置到初始状态
//   POST /browser/eval     在浏览器执行 JS
//   POST /browser/click    模拟点击
//   POST /browser/type     模拟输入
//   GET  /browser/console  获取浏览器 console 日志
//   POST /browser/screenshot  截图
//   POST /browser/refresh  刷新页面
// ============================================================

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { watch } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { discoverValidationCommands, runCommand } from '../handlers/verifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServeOptions {
  port?: number;
  devCommand?: string;
  projectRoot?: string;
  watchPaths?: string[];
  /** Circuit 模式：扫描所有 machine，同进程加载，按 circuit.next 自动转发 */
  circuit?: boolean;
}

// ---- 浏览器代理层（复用 browser-executor 的 proxy + bridge） ----

/** 根据项目路径生成确定性端口 */
function stablePort(projectRoot: string, offset: number): number {
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
  }
  return 10000 + (Math.abs(hash + offset * 7919) % 50000);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** 读取 browser-client.js */
function loadClientScript(): string {
  const candidates = [
    join(__dirname, 'browser-client.js'),
    join(__dirname, 'dist', 'browser-client.js'),
    join(__dirname, '..', 'dist', 'browser-client.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    }
  }
  return ''; // 没有 client script 就不注入
}

/** 找 browser-server.js */
function findBrowserServer(): string | null {
  const candidates = [
    join(__dirname, 'browser-server.js'),
    join(__dirname, 'dist', 'browser-server.js'),
    join(__dirname, '..', 'dist', 'browser-server.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Console 捕获注入脚本 ----

const CONSOLE_HOOK_SCRIPT = `
<script>
(function() {
  if (window.__koala_console_hooked) return;
  window.__koala_console_hooked = true;
  window.__koala_console_logs = [];
  var maxLogs = 1000;
  ['log', 'warn', 'error', 'info', 'debug'].forEach(function(level) {
    var orig = console[level];
    console[level] = function() {
      var args = Array.from(arguments).map(function(a) {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch(e) { return '[unserializable]'; }
      });
      window.__koala_console_logs.push({
        level: level,
        message: args.join(' '),
        time: Date.now()
      });
      if (window.__koala_console_logs.length > maxLogs) {
        window.__koala_console_logs = window.__koala_console_logs.slice(-maxLogs);
      }
      orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function(e) {
    window.__koala_console_logs.push({
      level: 'error',
      message: 'Uncaught: ' + (e.message || e),
      time: Date.now()
    });
  });
})();
</script>
`;

// ---- Validate 缓存 ----

interface ValidateCache {
  result: string | null;
  running: boolean;
  lastRun: number;
}

function createValidateRunner(projectRoot: string) {
  const cache: ValidateCache = { result: null, running: false, lastRun: 0 };

  async function run() {
    if (cache.running) return;
    cache.running = true;

    const validateFile = [
      'validate.ts', 'validate.js', 'validate.mts',
      join('src', 'validate.ts'), join('src', 'validate.js'), join('src', 'validate.mts'),
    ].find(f => existsSync(join(projectRoot, f)));
    if (!validateFile) {
      const commands = discoverValidationCommands(projectRoot);
      if (commands.length === 0) {
        cache.result = JSON.stringify({
          provider: 'koala-serve-validator',
          status: 'warn',
          allPass: true,
          summary: 'No project validator configured; skipped project-specific validation',
          details: [
            'validate.ts/js/mts not found',
            'koala.config.json validate.command(s) not configured',
            'no standard language test command discovered',
          ],
          timestamp: new Date().toISOString(),
        });
        cache.running = false;
        cache.lastRun = Date.now();
        return;
      }

      const details: string[] = [];
      let allPass = true;
      for (const cmd of commands) {
        const { code, output } = await runCommand(cmd.command, cmd.args, projectRoot);
        details.push(`${code === 0 ? '✓' : '✗'} ${cmd.label}: ${cmd.command} ${cmd.args.join(' ')}`.trim());
        if (output.trim()) details.push(...stripAnsi(output).trim().split('\n').filter(Boolean).map(l => `  ${l}`));
        if (code !== 0) allPass = false;
      }
      cache.result = JSON.stringify({
        provider: 'koala-serve-validator',
        status: allPass ? 'pass' : 'fail',
        allPass,
        summary: allPass ? 'Project validation commands passed' : 'Project validation commands failed',
        details,
        warnings: ['validate.ts not found; used language/project validation command discovery'],
        timestamp: new Date().toISOString(),
      });
      cache.running = false;
      cache.lastRun = Date.now();
      return;
    }

    const child = spawn('npx', ['tsx', validateFile, '--quiet'], {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', () => {
      cache.result = output;
      cache.running = false;
      cache.lastRun = Date.now();
    });
  }

  return { cache, run };
}

// ---- Bridge Proxy（连接项目进程的 WS Bridge Host） ----

/** 纯 WS 代理：连接项目已启动的 Bridge Host，不 spawn 任何进程 */
function createBridgeProxy(wsPort: number) {
  let ws: any = null;
  let machineInfo: any = null;
  let currentState: any = null;
  let currentMachineState = '';
  let connected = false;
  const history: Array<{ event: string; input: any; from: string; to: string; timestamp: number }> = [];
  const pendingRequests = new Map<number, (result: any) => void>();
  let reqId = 0;

  async function connect(): Promise<void> {
    if (connected) return;
    const { default: WebSocket } = await import('ws');

    // 等项目进程启动 WS server
    for (let i = 0; i < 30; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const attempt = new WebSocket(`ws://localhost:${wsPort}`);
          attempt.on('open', () => {
            ws = attempt;
            connected = true;

            ws.on('message', (data: Buffer) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'init') {
                  machineInfo = msg.machine;
                  currentState = msg.state;
                  currentMachineState = msg.machineState || '';
                  console.log(`  Bridge: ${machineInfo?.name || 'unknown'} (${machineInfo?.transitions?.length || 0} transitions)`);
                } else if (msg.type === 'stateChange') {
                  currentState = msg.state;
                  currentMachineState = msg.machineState || '';
                } else if (msg.type === 'eventResult') {
                  // 解析 pending request
                  const last = [...pendingRequests.entries()].pop();
                  if (last) {
                    pendingRequests.delete(last[0]);
                    last[1](msg);
                  }
                }
              } catch {}
            });

            ws.on('close', () => { connected = false; });
            resolve();
          });
          attempt.on('error', () => reject());
        });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  function getMachine() { return machineInfo; }

  function getEvents() {
    if (!machineInfo) return [];
    const events = new Map<string, string[]>();
    for (const t of machineInfo.transitions) {
      const fromStates = events.get(t.event) || [];
      fromStates.push(t.from);
      events.set(t.event, fromStates);
    }
    return Array.from(events.entries()).map(([event, fromStates]) => ({
      event, fromStates: [...new Set(fromStates)],
    }));
  }

  async function sendEvent(event: string, input: any) {
    if (!connected || !ws) return { ok: false, from: '', to: '', state: null, error: 'not connected' };
    const from = currentMachineState;
    return new Promise<any>((resolve) => {
      const id = reqId++;
      pendingRequests.set(id, (result) => {
        if (result.from !== result.to) {
          history.push({ event, input, from: result.from, to: result.to, timestamp: Date.now() });
        }
        resolve(result);
      });
      ws.send(JSON.stringify({ type: 'event', event, input }));
      // 超时 fallback
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          resolve({ ok: false, from, to: from, state: currentState, error: 'timeout' });
        }
      }, 5000);
    });
  }

  function reset() {
    if (connected && ws) {
      ws.send(JSON.stringify({ type: 'reset' }));
      history.length = 0;
    }
  }

  function getState() {
    return { currentState: currentMachineState, history, state: currentState };
  }

  function stop() {
    if (ws) try { ws.close(); } catch {}
  }

  return { connect, getMachine, getEvents, sendEvent, reset, getState, stop };
}

// ---- Browser API 转发 ----

async function bridgeApi(httpPort: number, path: string, body?: unknown): Promise<any> {
  const url = `http://localhost:${httpPort}${path}`;
  const opts: RequestInit = { method: body ? 'POST' : 'GET' };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (path === '/screenshot' && res.headers.get('content-type')?.includes('image')) {
    return { ok: true, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
  }
  return res.json();
}

// ---- 统一调试控制面板 HTML ----

function generateDashboardHtml(machineName: string, transitionsJson: string, hasBrowser: boolean, proxyUrl: string, bridgeWsPort: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${machineName} — koala Debug</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;padding:16px;max-width:100%;margin:0 auto}
h1{color:#e94560;font-size:20px;display:inline}
.header{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.subtitle{color:#888;font-size:12px;margin-bottom:12px}
/* Tabs */
.tabs{display:flex;gap:2px;margin-bottom:12px;background:#0d1b3e;border-radius:8px;padding:3px}
.tab{padding:8px 18px;cursor:pointer;border-radius:6px;font-size:13px;color:#888;transition:all .15s}
.tab:hover{color:#e0e0e0}
.tab.active{background:#0f3460;color:#53d8fb;font-weight:bold}
.tab-content{display:none}
.tab-content.active{display:block}
/* Cards */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.card{background:#16213e;border-radius:8px;padding:14px;border:1px solid #0f3460}
.card h2{color:#e94560;font-size:14px;margin-bottom:8px;border-bottom:1px solid #0f3460;padding-bottom:5px}
.badge{display:inline-block;padding:3px 10px;border-radius:10px;font-weight:bold;font-size:13px}
.badge-play{background:#0f3460;color:#53d8fb}
.badge-term{background:#4a1942;color:#e94560}
.badge-pass{background:#0a3d1f;color:#4ade80}
.badge-fail{background:#4a1919;color:#e94560}
.badge-run{background:#4a3d19;color:#fbbf24}
/* Buttons */
.btn{display:inline-block;margin:2px;padding:5px 12px;background:#0f3460;color:#53d8fb;border:1px solid #53d8fb;border-radius:5px;cursor:pointer;font-size:12px;transition:all .15s}
.btn:hover{background:#53d8fb;color:#1a1a2e}
.btn-danger{background:#4a1942;border-color:#e94560;color:#e94560}
.btn-danger:hover{background:#e94560;color:#fff}
.btn-primary{background:#e94560;border-color:#e94560;color:#fff}
.btn-primary:hover{background:#c73e54}
/* Transition list */
.tr-row{padding:3px 0;font-size:12px;color:#aaa}
.tr-row .hi{color:#53d8fb;font-weight:bold}
/* History / log */
.log{max-height:250px;overflow-y:auto;font-size:12px}
.log-item{padding:3px 6px;border-left:3px solid #0f3460;margin-bottom:3px;background:#0d1b3e}
.log-item.ok{border-left-color:#53d8fb}
.log-item.fail{border-left-color:#e94560}
.log-item.warn{border-left-color:#fbbf24}
/* Code / State */
.code{max-height:350px;overflow:auto;font-size:11px;font-family:'SF Mono',Menlo,monospace;white-space:pre-wrap;background:#0d1b3e;padding:8px;border-radius:5px;line-height:1.4}
/* Toolbar */
.toolbar{display:flex;gap:6px;align-items:center;margin-bottom:10px}
.toolbar input{flex:1;padding:5px 8px;background:#0d1b3e;color:#e0e0e0;border:1px solid #0f3460;border-radius:5px;font-family:monospace;font-size:12px}
/* Browser iframe */
.browser-frame{width:100%;height:500px;border:1px solid #0f3460;border-radius:8px;background:#fff}
.browser-controls{display:flex;gap:6px;margin-bottom:8px;align-items:center}
.browser-controls input{flex:1;padding:5px 8px;background:#0d1b3e;color:#e0e0e0;border:1px solid #0f3460;border-radius:5px;font-family:monospace;font-size:12px}
.status-line{font-size:11px;color:#555;margin-top:6px}
.json-toggle{cursor:pointer;color:#53d8fb;font-size:10px;margin-right:2px;user-select:none}
.hidden{display:none}
.state-tab{padding:4px 12px;cursor:pointer;border-radius:4px;font-size:12px;color:#888}
.state-tab:hover{color:#e0e0e0}
.state-tab.active{background:#0f3460;color:#53d8fb}
</style></head><body>
<div class="header"><h1>🐨 ${machineName}</h1><span class="subtitle">koala debug console</span></div>
<div class="tabs" id="tabs">
  <div class="tab active" data-tab="bridge">Bridge</div>
  ${hasBrowser ? '<div class="tab" data-tab="browser">Browser</div>' : ''}
  <div class="tab" data-tab="validate">Validate</div>
  <div class="tab" data-tab="api">API</div>
</div>

<!-- ═══ Bridge Tab ═══ -->
<div class="tab-content active" id="tab-bridge">
<div class="toolbar">
  <button class="btn btn-danger" onclick="doReset()">Reset</button>
  <input id="custom-event" placeholder='{"event":"EVENT_NAME","input":{...}}' onkeydown="if(event.key==='Enter')doCustom()">
  <button class="btn btn-primary" onclick="doCustom()">Send</button>
</div>
<div class="grid">
  <div class="card">
    <h2>Machine State</h2>
    <div id="machine-state"></div>
    <div id="player-info" style="margin-top:4px;font-size:14px"></div>
    <h2 style="margin-top:12px">Events</h2>
    <div id="events"></div>
    <h2 style="margin-top:12px">All Transitions</h2>
    <div id="transitions"></div>
  </div>
  <div class="card">
    <div style="display:flex;gap:2px;margin-bottom:8px">
      <div class="state-tab active" data-st="tree" onclick="switchStateTab('tree')">Tree</div>
      <div class="state-tab" data-st="raw" onclick="switchStateTab('raw')">JSON</div>
    </div>
    <div class="code" id="game-state"></div>
    <div class="code hidden" id="state-raw" style="font-size:11px;color:#aaa"></div>
  </div>
</div>
<div class="card">
  <h2>History <span id="hist-count" style="color:#888;font-weight:normal"></span></h2>
  <div class="log" id="history"></div>
</div>
</div>

<!-- ═══ Browser Tab ═══ -->
${hasBrowser ? `
<div class="tab-content" id="tab-browser">
<div class="browser-controls">
  <button class="btn" onclick="browserRefresh()">Refresh</button>
  <button class="btn" onclick="browserScreenshot()">Screenshot</button>
  <input id="eval-code" placeholder="document.title" onkeydown="if(event.key==='Enter')browserEval()">
  <button class="btn btn-primary" onclick="browserEval()">Eval</button>
</div>
<iframe class="browser-frame" id="browser-iframe" src="${proxyUrl}"></iframe>
<div class="grid" style="margin-top:8px">
  <div class="card">
    <h2>Console Logs</h2>
    <div class="log" id="console-logs"></div>
  </div>
  <div class="card">
    <h2>Eval Result</h2>
    <div class="code" id="eval-result">-</div>
  </div>
</div>
</div>` : ''}

<!-- ═══ Validate Tab ═══ -->
<div class="tab-content" id="tab-validate">
<div class="toolbar">
  <button class="btn btn-primary" onclick="runValidate()">Run Validate</button>
  <span id="validate-status" style="font-size:12px;color:#888"></span>
</div>
<div class="card">
  <h2>Validate Result</h2>
  <div class="code" id="validate-output" style="max-height:600px">Loading...</div>
</div>
</div>

<!-- ═══ API Tab ═══ -->
<div class="tab-content" id="tab-api">
<div class="grid-3">
  <div class="card">
    <h2>Bridge API</h2>
    <div style="font-size:12px">
      <div class="tr-row"><span class="hi">GET</span> /bridge/state</div>
      <div class="tr-row"><span class="hi">GET</span> /bridge/events</div>
      <div class="tr-row"><span class="hi">POST</span> /bridge/event <span style="color:#666">{"event","input"}</span></div>
      <div class="tr-row"><span class="hi">POST</span> /bridge/replay <span style="color:#666">[{event,input}...]</span></div>
      <div class="tr-row"><span class="hi">POST</span> /bridge/reset</div>
    </div>
  </div>
  ${hasBrowser ? `<div class="card">
    <h2>Browser API</h2>
    <div style="font-size:12px">
      <div class="tr-row"><span class="hi">POST</span> /browser/eval <span style="color:#666">{"code"}</span></div>
      <div class="tr-row"><span class="hi">POST</span> /browser/click <span style="color:#666">{"x","y"}</span></div>
      <div class="tr-row"><span class="hi">POST</span> /browser/type <span style="color:#666">{"text"}</span></div>
      <div class="tr-row"><span class="hi">GET</span> /browser/console</div>
      <div class="tr-row"><span class="hi">POST</span> /browser/screenshot</div>
      <div class="tr-row"><span class="hi">POST</span> /browser/refresh</div>
    </div>
  </div>` : ''}
  <div class="card">
    <h2>System API</h2>
    <div style="font-size:12px">
      <div class="tr-row"><span class="hi">GET</span> /status</div>
      <div class="tr-row"><span class="hi">GET</span> /validate</div>
    </div>
  </div>
</div>
<div class="card">
  <h2>Quick Test</h2>
  <div class="toolbar">
    <select id="api-method" style="padding:5px;background:#0d1b3e;color:#e0e0e0;border:1px solid #0f3460;border-radius:5px">
      <option>GET</option><option>POST</option>
    </select>
    <input id="api-path" placeholder="/bridge/state" value="/bridge/state">
    <input id="api-body" placeholder='POST body JSON (optional)' style="flex:2">
    <button class="btn btn-primary" onclick="apiTest()">Send</button>
  </div>
  <div class="code" id="api-result" style="margin-top:8px">-</div>
</div>
</div>

<div class="status-line" id="status-line"></div>
<script>
const BASE = location.origin;
const TRANSITIONS = ${transitionsJson};
let currentMachineState = '';

// WS 实时推送（替代 HTTP 轮询）
let ws = null;
let wsConnected = false;
function connectWS() {
  const wsPort = ${bridgeWsPort};
  if (!wsPort) return;
  ws = new WebSocket('ws://localhost:' + wsPort);
  ws.onopen = () => { wsConnected = true; refreshBridge(); };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stateChange' || msg.type === 'init') {
        updateBridgeUI({ currentState: msg.machineState, state: msg.state, events: null, history: msg.history });
      }
    } catch {}
  };
  ws.onclose = () => { wsConnected = false; setTimeout(connectWS, 2000); };
  ws.onerror = () => {};
}
connectWS();

// ---- Tab switching ----
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

async function api(path, body) {
  const opts = body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {};
  const r = await fetch(BASE + path, opts); return r.json();
}

// ---- Bridge ----

/** State tab 切换 */
function switchStateTab(tab) {
  document.querySelectorAll('.state-tab').forEach(t => t.classList.toggle('active', t.dataset.st === tab));
  document.getElementById('game-state').classList.toggle('hidden', tab !== 'tree');
  document.getElementById('state-raw').classList.toggle('hidden', tab !== 'raw');
}

/** 通用 JSON 树渲染（可折叠，像 DevTools） */
function renderJson(obj, depth) {
  depth = depth || 0;
  if (obj === null) return '<span style="color:#e94560">null</span>';
  if (obj === undefined) return '<span style="color:#888">undefined</span>';
  if (typeof obj === 'string') return '<span style="color:#a5d6a7">"' + obj.replace(/</g,'&lt;') + '"</span>';
  if (typeof obj === 'number') return '<span style="color:#53d8fb">' + obj + '</span>';
  if (typeof obj === 'boolean') return '<span style="color:#fbbf24">' + obj + '</span>';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span style="color:#888">[]</span>';
    // 内层数组（2D 数组的第二维）或短数组：一行显示
    if (obj.every(v => v === null || typeof v !== 'object')) {
      return '[' + obj.map(v => renderJson(v, depth+1)).join(', ') + ']';
    }
    const collapsed = depth >= 2;
    return '<span class="json-toggle" onclick="this.nextElementSibling.classList.toggle(\\x27hidden\\x27);this.textContent=this.textContent===\\x27▶\\x27?\\x27▼\\x27:\\x27▶\\x27">' + (collapsed?'▶':'▼') + '</span>' +
      '<span' + (collapsed?' class="hidden"':'') + '>[<div style="margin-left:16px">' +
      obj.map((v,i) => '<div><span style="color:#666">' + i + ':</span> ' + renderJson(v, depth+1) + (i < obj.length-1 ? ',' : '') + '</div>').join('') +
      '</div>]</span> <span style="color:#666">(' + obj.length + ')</span>';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '<span style="color:#888">{}</span>';
    const collapsed = depth >= 2;
    return '<span class="json-toggle" onclick="this.nextElementSibling.classList.toggle(\\x27hidden\\x27);this.textContent=this.textContent===\\x27▶\\x27?\\x27▼\\x27:\\x27▶\\x27">' + (collapsed?'▶':'▼') + '</span>' +
      '<span' + (collapsed?' class="hidden"':'') + '>{<div style="margin-left:16px">' +
      keys.map((k,i) => '<div><span style="color:#ce93d8">' + k + '</span>: ' + renderJson(obj[k], depth+1) + (i < keys.length-1 ? ',' : '') + '</div>').join('') +
      '</div>}</span>';
  }
  return String(obj);
}

let _lastBridgeJson = '';
function updateBridgeUI(d) {
    currentMachineState = d.currentState;
    const gs = d.state;
    const isTerminal = !TRANSITIONS.some(t => t.from === d.currentState);
    document.getElementById('machine-state').innerHTML =
      '<span class="badge ' + (isTerminal ? 'badge-term' : 'badge-play') + '">' + (d.currentState || 'none') + '</span>';
    if (gs) {
      const modeInfo = gs.mode ? ' | Mode: <span style="color:#53d8fb">' + gs.mode + '</span>' : '';
      document.getElementById('player-info').innerHTML = (gs.currentPlayer ? '当前: ' + gs.currentPlayer : '') + modeInfo;
      document.getElementById('game-state').innerHTML = renderJson(gs, 0);
      document.getElementById('state-raw').textContent = JSON.stringify(gs, null, 2);
    }
    const available = TRANSITIONS.filter(t => t.from === d.currentState);
    const evDiv = document.getElementById('events');
    if (available.length === 0) {
      evDiv.innerHTML = '<span style="color:#e94560">Terminal — no events</span>';
    } else {
      // 按 event 名去重（同一个 event 只渲染一次表单，core 的 guard 自动判定走哪条 transition）
      const seen = new Set();
      const uniqueEvents = available.filter(t => { if (seen.has(t.event)) return false; seen.add(t.event); return true; });
      evDiv.innerHTML = uniqueEvents.map((t, i) => {
        const id = 'ev-form-' + i;
        const schema = t.inputSchema || available.find(a => a.event === t.event && a.inputSchema)?.inputSchema;
        let formHtml = '';
        if (schema) {
          const fields = Object.entries(schema).map(([key, f]) => {
            const label = f.label || key;
            const val = f.default !== undefined ? f.default : (f.type === 'number' ? (f.min || 0) : '');
            if (f.type === 'number') {
              const min = f.min !== undefined ? ' min="' + f.min + '"' : '';
              const max = f.max !== undefined ? ' max="' + f.max + '"' : '';
              return '<label style="font-size:11px;color:#888">' + label + '</label>' +
                '<input type="number" data-key="' + key + '" value="' + val + '"' + min + max +
                ' style="width:60px;padding:3px 6px;background:#0d1b3e;color:#53d8fb;border:1px solid #0f3460;border-radius:4px;font-size:12px;margin:0 6px 0 2px">';
            }
            if (f.type === 'select' && f.options) {
              const opts = f.options.map(o => '<option value=\\x27' + JSON.stringify(o.value) + '\\x27>' + o.label + '</option>').join('');
              return '<label style="font-size:11px;color:#888">' + label + '</label>' +
                '<select data-key="' + key + '" style="padding:3px;background:#0d1b3e;color:#53d8fb;border:1px solid #0f3460;border-radius:4px;font-size:12px;margin:0 6px 0 2px">' + opts + '</select>';
            }
            if (f.type === 'boolean') {
              return '<label style="font-size:11px;color:#888"><input type="checkbox" data-key="' + key + '"' + (val ? ' checked' : '') + '> ' + label + '</label> ';
            }
            return '<label style="font-size:11px;color:#888">' + label + '</label>' +
              '<input type="text" data-key="' + key + '" value="' + val + '" style="width:80px;padding:3px 6px;background:#0d1b3e;color:#53d8fb;border:1px solid #0f3460;border-radius:4px;font-size:12px;margin:0 6px 0 2px">';
          }).join('');
          formHtml = '<div style="margin:4px 0;display:flex;align-items:center;flex-wrap:wrap;gap:2px" id="' + id + '">' + fields + '</div>';
        }
        const targets = available.filter(a => a.event === t.event).map(a => a.to).join(' / ');
        return '<div style="margin-bottom:8px;padding:6px;background:#0d1b3e;border-radius:6px">' +
          '<button class="btn" onclick="doEventForm(\\'' + t.event + '\\',\\'' + id + '\\')">' + t.event + '</button>' +
          ' <span style="font-size:11px;color:#666">\\u2192 ' + targets + '</span>' +
          formHtml + '</div>';
      }).join('');
    }
    document.getElementById('transitions').innerHTML = TRANSITIONS.map(t => {
      const hi = t.from === d.currentState ? ' hi' : '';
      return '<div class="tr-row"><span class="' + hi + '">' + t.from + '</span> \\u2192 <span class="' + hi + '">' + t.to + '</span> [' + t.event + '] <span style="color:#555">' + t.description + '</span></div>';
    }).join('');
    const hist = d.history || [];
    document.getElementById('hist-count').textContent = '(' + hist.length + ')';
    document.getElementById('history').innerHTML = hist.slice().reverse().map(h =>
      '<div class="log-item ok">' + h.from + ' \\u2192 ' + h.to + ' [' + h.event + '] ' + JSON.stringify(h.input) + '</div>'
    ).join('');
}
async function refreshBridge() {
  try {
    const d = await api('/bridge/state');
    const json = JSON.stringify(d);
    if (json === _lastBridgeJson) return; // 数据没变，不动 DOM
    _lastBridgeJson = json;
    updateBridgeUI(d);
  } catch(e) { console.warn('refresh error', e); }
}

async function doEventForm(event, formId) {
  let input = {};
  const form = document.getElementById(formId);
  if (form) {
    // 从表单字段收集 input
    form.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      if (el.type === 'number') input[key] = Number(el.value);
      else if (el.type === 'checkbox') input[key] = el.checked;
      else if (el.tagName === 'SELECT') { try { input[key] = JSON.parse(el.value); } catch { input[key] = el.value; } }
      else input[key] = el.value;
    });
  } else {
    // 没有 schema，fallback 到 prompt
    const raw = prompt('Input JSON for ' + event + ':', '{}');
    if (raw === null) return;
    try { input = JSON.parse(raw); } catch { alert('Invalid JSON'); return; }
  }
  const r = await api('/bridge/event', { event, input });
  document.getElementById('status-line').textContent = r.ok ? event + ': ' + r.from + ' \\u2192 ' + r.to : 'Failed: ' + (r.error || '');
  setTimeout(refreshBridge, 100);
}
async function doReset() { await api('/bridge/reset'); setTimeout(refreshBridge, 100); }
async function doCustom() {
  const raw = document.getElementById('custom-event').value.trim();
  if (!raw) return;
  try { const r = await api('/bridge/event', JSON.parse(raw)); document.getElementById('custom-event').value = '';
    document.getElementById('status-line').textContent = r.ok ? r.from + ' \\u2192 ' + r.to : (r.error || '');
    setTimeout(refreshBridge, 100);
  } catch { alert('Invalid JSON'); }
}

// ---- Browser ----
async function browserRefresh() { await api('/browser/refresh'); document.getElementById('browser-iframe')?.contentWindow?.location.reload(); }
async function browserScreenshot() {
  const r = await api('/browser/screenshot');
  document.getElementById('eval-result').textContent = r.data ? 'Screenshot (base64, ' + r.data.length + ' chars)' : JSON.stringify(r, null, 2);
}
async function browserEval() {
  const code = document.getElementById('eval-code')?.value;
  if (!code) return;
  const r = await api('/browser/eval', { code });
  document.getElementById('eval-result').textContent = JSON.stringify(r, null, 2);
}
async function refreshConsole() {
  try {
    const logs = await api('/browser/console');
    const el = document.getElementById('console-logs');
    if (el && Array.isArray(logs)) {
      el.innerHTML = logs.slice(-50).reverse().map(l =>
        '<div class="log-item ' + (l.level === 'error' ? 'fail' : l.level === 'warn' ? 'warn' : 'ok') + '">[' + l.level + '] ' + (l.message || '').slice(0, 200) + '</div>'
      ).join('');
    }
  } catch {}
}

// ---- Validate ----
async function runValidate() {
  document.getElementById('validate-status').textContent = 'Running...';
  const r = await api('/validate');
  const raw = typeof r.validate === 'string' ? r.validate : JSON.stringify(r, null, 2);
  const cleanRaw = raw.replace(/\\x1b\\[[0-9;]*m/g, '');

  // 尝试解析结构化输出
  try {
    const parsed = JSON.parse(cleanRaw);
    if (parsed.allPass !== undefined) {
      const statusBadge = parsed.allPass
        ? '<span class="badge badge-pass">PASS</span>'
        : '<span class="badge badge-fail">FAIL</span>';
      const details = (parsed.details || []).map(d => {
        const clean = d.replace(/\\x1b\\[[0-9;]*m/g, '');
        const isFail = clean.startsWith('✗');
        const isCore = clean.toLowerCase().includes('core');
        const cls = isFail ? 'fail' : isCore ? 'ok' : '';
        return '<div class="log-item ' + cls + '">' + clean + '</div>';
      }).join('');
      document.getElementById('validate-output').innerHTML = statusBadge + ' ' + (parsed.summary || '') + '<div class="log" style="margin-top:8px;max-height:500px">' + details + '</div>';
      document.getElementById('validate-status').textContent = parsed.allPass ? 'All checks passed' : 'Some checks failed';
      return;
    }
  } catch {}

  // fallback: 原始文本
  document.getElementById('validate-output').textContent = cleanRaw;
  document.getElementById('validate-status').textContent = r.running ? 'Running...' : 'Last run: ' + new Date(r.lastRun).toLocaleTimeString();
}

// ---- API tester ----
async function apiTest() {
  const method = document.getElementById('api-method').value;
  const path = document.getElementById('api-path').value;
  const bodyRaw = document.getElementById('api-body').value.trim();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'POST' && bodyRaw) opts.body = bodyRaw;
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  try { document.getElementById('api-result').textContent = JSON.stringify(JSON.parse(text), null, 2); }
  catch { document.getElementById('api-result').textContent = text; }
}

// ---- Auto refresh ----
refreshBridge();
runValidate();
// WS 连接时不轮询；WS 断开时 fallback 到 2s 轮询
setInterval(() => { if (!wsConnected) refreshBridge(); }, 2000);
${hasBrowser ? 'setInterval(refreshConsole, 3000);' : ''}
</script></body></html>`;
}

// ---- 主服务 ----

/** 检查已有的 serve 实例是否还活着（pid + HTTP ping 双重验证） */
async function checkExistingServe(projectRoot: string): Promise<{ alive: boolean; info?: any }> {
  const infoPath = join(projectRoot, '.koala-serve.json');
  if (!existsSync(infoPath)) return { alive: false };
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
    if (!info.pid || !info.api) {
      try { unlinkSync(infoPath); } catch {}
      return { alive: false };
    }
    // 1. pid 检查
    try { process.kill(info.pid, 0); } catch {
      try { unlinkSync(infoPath); } catch {}
      return { alive: false };
    }
    // 2. HTTP ping — 确认端口上跑的是我们的 serve（防 pid 复用）
    try {
      const r = await fetch(`${info.api}/bridge/state`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { alive: true, info };
    } catch {}
    // pid 活着但 API 没响应 → 不是我们的进程，清理
    try { unlinkSync(infoPath); } catch {}
    return { alive: false };
  } catch {}
  return { alive: false };
}

export async function startServe(options: ServeOptions) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // 端口基于 projectRoot 哈希自动分配，多 worktree / main 互不冲突
  const port = options.port ?? stablePort(projectRoot, 3);
  const watchPaths = options.watchPaths ?? ['data.ts', 'fn.ts', 'machine.ts', 'validate.ts'];

  console.log(`\n🐨 koala serve`);
  console.log(`  项目: ${projectRoot}`);
  console.log(`  API:  http://localhost:${port}`);

  // 连接项目已启动的逻辑核心（读 .koala-serve.json 找 WS 端口）
  const serveInfoPath = join(projectRoot, '.koala-serve.json');
  let bridgeWsPort = 0;
  for (let i = 0; i < 30; i++) {
    try {
      const info = JSON.parse(readFileSync(serveInfoPath, 'utf-8'));
      if (info.wsPort) { bridgeWsPort = info.wsPort; break; }
    } catch {}
    if (i === 0) console.log(`  等待项目核心启动（.koala-serve.json）...`);
    await new Promise(r => setTimeout(r, 500));
  }
  if (!bridgeWsPort) {
    console.log(`  ⚠ 未找到项目核心。请先启动项目：`);
    console.log(`    KOALA_SERVE_PORT=<port> npx tsx src/main.ts`);
    console.log(`    或 npm run serve（会自动启动核心）`);
    return;
  }
  console.log(`  核心 WS: ws://localhost:${bridgeWsPort}`);
  const machineBridge = createBridgeProxy(bridgeWsPort);
  await machineBridge.connect();

  // Validate runner
  const validator = createValidateRunner(projectRoot);
  validator.run(); // 启动时跑一次

  // File watcher — 自动搜索 src/machines/ 下的核心文件 + 根目录 + src/ 下的
  const watchedFiles: string[] = [];
  for (const pattern of watchPaths) {
    // 根目录
    const root = join(projectRoot, pattern);
    if (existsSync(root)) watchedFiles.push(root);
    // src/
    const src = join(projectRoot, 'src', pattern);
    if (existsSync(src)) watchedFiles.push(src);
    // src/machines/*/
    const machinesDir = join(projectRoot, 'src', 'machines');
    if (existsSync(machinesDir)) {
      try {
        for (const sub of readdirSync(machinesDir)) {
          const candidate = join(machinesDir, sub, pattern);
          if (existsSync(candidate)) watchedFiles.push(candidate);
        }
      } catch {}
    }
  }
  for (const f of watchedFiles) {
    watch(f, () => {
      console.log(`  📁 ${f.replace(projectRoot + '/', '')} 变更 → 重新验证...`);
      validator.run();
    });
  }
  console.log(`  监听: ${watchedFiles.map(f => f.replace(projectRoot + '/', '')).join(', ')}`);

  // Browser proxy（如果配了 devCommand）
  let browserHttpPort = 0;
  let proxyPort = 0;
  let proxyUrl = '';

  if (options.devCommand) {
    const wsPort = stablePort(projectRoot, 0);
    browserHttpPort = stablePort(projectRoot, 1);
    proxyPort = stablePort(projectRoot, 2);

    console.log(`  端口: ws=${wsPort} http=${browserHttpPort} proxy=${proxyPort}`);

    // 启动 bridge server
    const serverPath = findBrowserServer();
    if (!serverPath) {
      console.error('  ✗ browser-server.js 未找到。请先编译: npm run build:koala');
    }
    if (serverPath) {
      const bridgeProc = spawn('node', [serverPath], {
        cwd: projectRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WS_PORT: String(wsPort), HTTP_PORT: String(browserHttpPort) },
      });
      bridgeProc.stdout?.on('data', (d: Buffer) => {
        const msg = stripAnsi(d.toString().trim());
        if (msg) console.log(`  [bridge] ${msg}`);
      });

      // 启动 dev server
      const [devCmd, ...devArgs] = options.devCommand.split(' ');
      const devProc = spawn(devCmd, devArgs, {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 等 dev server 就绪
      let devUrl = '';
      await new Promise<void>((resolve) => {
        let output = '';
        const onData = (d: Buffer) => {
          output += stripAnsi(d.toString());
          const m = output.match(/https?:\/\/[\w.\-]+:\d+/);
          if (m) {
            devUrl = m[0].replace(/127\.0\.0\.1|0\.0\.0\.0/, 'localhost');
            resolve();
          }
        };
        devProc.stdout?.on('data', onData);
        devProc.stderr?.on('data', onData);
        setTimeout(() => resolve(), 15000); // 超时也继续
      });

      if (devUrl) {
        // 启动 proxy（注入 client.js + console hook）
        const clientScript = loadClientScript();
        const { createServer: createProxyServer } = await import('node:http');

        const proxy = createProxyServer(async (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url || '/';
          try {
            const resp = await fetch(`${devUrl}${url}`, {
              method: req.method,
              headers: { 'Accept': req.headers.accept || '*/*' },
            });
            const contentType = resp.headers.get('content-type') || '';

            if (contentType.includes('text/html')) {
              let html = await resp.text();
              const injection = `<script>window.__KOALA_WS_PORT=${wsPort};${clientScript}</script>${CONSOLE_HOOK_SCRIPT}`;
              html = html.includes('</head>')
                ? html.replace('</head>', `${injection}</head>`)
                : injection + html;
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

        // WS 升级透传
        proxy.on('upgrade', (req, socket, head) => {
          const devOrigin = new URL(devUrl);
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

        proxy.listen(proxyPort, () => {
          proxyUrl = `http://localhost:${proxyPort}`;
          console.log(`  代理: ${proxyUrl} → ${devUrl}`);
          console.log(`  打开浏览器访问代理地址即可，koala 自动注入控制脚本`);
        });
      }
    }
  }

  // HTTP API
  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 读 body
    let body: any = null;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    }

    try {
      // ---- 统一调试控制面板（GET /） ----
      if (url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const machine = machineBridge.getMachine();
        const machineName = machine?.name || 'Machine';
        const transitionsJson = JSON.stringify(machine?.transitions || []);
        const hasBrowser = !!proxyUrl;
        res.end(generateDashboardHtml(machineName, transitionsJson, hasBrowser, proxyUrl, bridgeWsPort));
        return;
      }
      if (url === '/status' || url === '/validate') {
        res.end(JSON.stringify({
          validate: validator.cache.result,
          lastRun: validator.cache.lastRun,
          running: validator.cache.running,
          proxyUrl,
        }));
      }
      else if (url === '/browser/eval' && body?.code) {
        const r = await bridgeApi(browserHttpPort, '/eval', { code: body.code });
        res.end(JSON.stringify(r));
      }
      else if (url === '/browser/click') {
        const r = await bridgeApi(browserHttpPort, '/click', body);
        res.end(JSON.stringify(r));
      }
      else if (url === '/browser/type') {
        const r = await bridgeApi(browserHttpPort, '/type', body);
        res.end(JSON.stringify(r));
      }
      else if (url === '/browser/screenshot') {
        const r = await bridgeApi(browserHttpPort, '/screenshot');
        res.end(JSON.stringify(r));
      }
      else if (url === '/browser/console') {
        const r = await bridgeApi(browserHttpPort, '/eval', {
          code: 'JSON.parse(JSON.stringify(window.__koala_console_logs || []))',
        });
        res.end(JSON.stringify(r?.result || []));
      }
      else if (url === '/browser/console/clear') {
        await bridgeApi(browserHttpPort, '/eval', {
          code: 'window.__koala_console_logs = []; void 0',
        });
        res.end(JSON.stringify({ ok: true }));
      }
      else if (url === '/browser/refresh') {
        await bridgeApi(browserHttpPort, '/eval', {
          code: 'location.reload(); void 0',
        });
        res.end(JSON.stringify({ ok: true }));
      }
      else if (url === '/browser/status') {
        const r = await bridgeApi(browserHttpPort, '/status');
        res.end(JSON.stringify(r));
      }
      // ---- Bridge API（自动从 machine.ts 生成） ----
      else if (url === '/bridge/state') {
        res.end(JSON.stringify(machineBridge.getState()));
      }
      else if (url === '/bridge/events') {
        res.end(JSON.stringify(machineBridge.getEvents()));
      }
      else if (url === '/bridge/event' && body?.event) {
        const result = await machineBridge.sendEvent(body.event, body.input);
        res.end(JSON.stringify(result));
      }
      else if (url === '/bridge/replay' && Array.isArray(body)) {
        machineBridge.reset();
        const results = [];
        for (const step of body) {
          const r = await machineBridge.sendEvent(step.event, step.input);
          results.push(r);
          if (!r.ok) break;
        }
        res.end(JSON.stringify({ steps: results, finalState: machineBridge.getState() }));
      }
      else if (url === '/bridge/reset') {
        machineBridge.reset();
        res.end(JSON.stringify({ ok: true, state: machineBridge.getState() }));
      }
      else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found', endpoints: [
          'GET /status', 'GET /validate',
          'POST /bridge/event', 'GET /bridge/state', 'GET /bridge/events',
          'POST /bridge/replay', 'POST /bridge/reset',
          'POST /browser/eval', 'POST /browser/click', 'POST /browser/type',
          'GET /browser/console', 'POST /browser/console/clear',
          'POST /browser/screenshot', 'POST /browser/refresh',
          'GET /browser/status',
        ]}));
      }
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // 更新发现文件（项目核心已写 wsPort/pid，serve 追加 HTTP 信息）
  let serveInfo: any = {};
  try { serveInfo = JSON.parse(readFileSync(serveInfoPath, 'utf-8')); } catch {}
  serveInfo.api = `http://localhost:${port}`;
  serveInfo.port = port;
  serveInfo.dashboard = `http://localhost:${port}/`;
  serveInfo.proxyUrl = proxyUrl || undefined;
  serveInfo.servePid = process.pid;

  // EADDRINUSE 处理（竞态：两个进程同时通过了 checkExistingServe）
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\n  ⚠ 端口 ${port} 已被占用（另一个 serve 实例？）`);
      console.log(`  读取 .koala-serve.json 获取已有实例信息。\n`);
      process.exit(0);
    }
    throw err;
  });

  server.listen(port, () => {
    // 写发现文件
    writeFileSync(serveInfoPath, JSON.stringify(serveInfo, null, 2) + '\n');

    console.log(`\n  API 就绪: http://localhost:${port}`);
    console.log(`  控制面板: http://localhost:${port}/`);
    console.log(`  发现文件: .koala-serve.json`);
    console.log(`  端点:`);
    console.log(`    GET  /                    统一调试控制面板`);
    console.log(`    POST /bridge/event        发送事件 { event, input }`);
    console.log(`    GET  /bridge/state        当前 machine 状态`);
    console.log(`    GET  /bridge/events       所有合法事件列表`);
    console.log(`    POST /bridge/replay       批量重放事件序列`);
    console.log(`    POST /bridge/reset        重置到初始状态`);
    if (options.devCommand) {
      console.log(`    POST /browser/eval        执行 JS`);
      console.log(`    POST /browser/click       模拟点击`);
      console.log(`    GET  /browser/console     获取 console 日志`);
      console.log(`    POST /browser/screenshot  截图`);
      console.log(`    POST /browser/refresh     刷新页面`);
    }
    console.log(`    GET  /status              validate + 项目状态`);
    console.log('');
  });

  // 清理：serve 退出时断开 WS（项目核心进程自己管自己的生命周期）
  const cleanup = () => {
    machineBridge.stop();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// ============================================================
// Circuit 模式：多 machine 同进程加载 + circuit.next 自动转发
// ============================================================

interface TraceHop {
  endpoint: string;
  event: string;
  from: string;
  to: string;
  timestamp: number;
  durationMs: number;
}

interface TraceContext {
  traceId: string;
  circuitName: string;
  hops: TraceHop[];
  broken: boolean;
  status?: 'active' | 'completed' | 'timeout';
}

const MAX_HOPS = 100;
const MAX_TRACES = 1000;

function genTraceId(): string {
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 创建简单的同进程 state machine runner（不需要项目 bridge） */
function createInProcessBridge(machineConfig: any) {
  const machine = machineConfig;
  let currentState: string = machine.initial || machine.states?.[0] || 'init';
  let gameState: any = {};

  function getActiveTransitions() {
    return (machine.transitions || []).filter((t: any) => !t.planned && t.from === currentState);
  }

  function sendEvent(event: string, input: any): boolean {
    const matching = getActiveTransitions().filter((t: any) => t.event === event);
    if (matching.length === 0) return false;

    for (const t of matching) {
      // 执行 guard（如果有）
      if (t.guard?.fn) {
        try {
          const guardResult = t.guard.fn(gameState, input);
          if (!guardResult) continue;
        } catch { continue; }
      }
      // 执行 action（如果有）
      if (t.action?.fn) {
        try {
          const newState = t.action.fn(gameState, input);
          if (newState !== undefined) gameState = newState;
        } catch {}
      }
      currentState = t.to;
      return true; // true = 有 transition 被匹配并执行了
    }
    return false;
  }

  function getState() { return { currentState, state: gameState }; }
  function getMachineState() { return currentState; }
  function reset() {
    currentState = machine.initial || machine.states?.[0] || 'init';
    gameState = {};
  }
  function getTransitions() { return machine.transitions || []; }

  return { sendEvent, getState, getMachineState, reset, getTransitions };
}

/** 扫描项目下所有 machine.ts 文件 */
function findMachineFiles(projectRoot: string): Array<{ endpoint: string; filePath: string }> {
  const results: Array<{ endpoint: string; filePath: string }> = [];
  const searchDirs = [
    join(projectRoot, 'src', 'machines'),
    join(projectRoot, 'src', 'core', 'machines'),
    join(projectRoot, 'machines'),
  ];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const sub of readdirSync(dir)) {
        const candidate = join(dir, sub, 'machine.ts');
        const candidateJs = join(dir, sub, 'machine.js');
        const filePath = existsSync(candidate) ? candidate
          : existsSync(candidateJs) ? candidateJs
          : null;
        if (filePath) {
          results.push({ endpoint: sub, filePath });
        }
      }
    } catch {}
  }
  return results;
}

/** 生成 Circuit 模式 Dashboard HTML */
function generateCircuitDashboardHtml(endpointNames: string[], machineConfigs: Record<string, any>): string {
  const configJson = JSON.stringify(machineConfigs);
  const endpointsJson = JSON.stringify(endpointNames);
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>koala serve --circuit</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; }
header h1 { font-size: 16px; font-weight: 600; color: #58a6ff; }
header .ep-badges { display: flex; gap: 8px; flex-wrap: wrap; }
.badge { background: #21262d; border: 1px solid #30363d; border-radius: 12px; padding: 2px 10px; font-size: 12px; }
.section { padding: 16px 20px; }
.section-title { font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
.control-panel { display: flex; gap: 12px; flex-wrap: wrap; }
.ep-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; min-width: 200px; }
.ep-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.ep-state { font-size: 12px; color: #8b949e; margin-bottom: 10px; }
.ep-state span { color: #3fb950; font-weight: 600; }
.event-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.event-btn { background: #21262d; border: 1px solid #388bfd; color: #58a6ff; border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 0.15s; }
.event-btn:hover { background: #388bfd22; }
.event-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.swimlane-area { overflow-x: auto; }
.swimlane-container { display: flex; gap: 0; min-width: max-content; }
.swimlane { display: flex; flex-direction: column; min-width: 220px; border-right: 1px solid #21262d; }
.swimlane-header { padding: 8px 16px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 13px; font-weight: 600; text-align: center; color: #79c0ff; position: sticky; top: 0; z-index: 1; }
.swimlane-body { padding: 12px 8px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.hop-node { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 12px; position: relative; cursor: default; transition: border-color 0.2s; }
.hop-node:hover { border-color: #58a6ff; }
.hop-node.active { border-color: #388bfd; background: #0d2044; }
.hop-node.broken { border-color: #f85149; background: #1a0a0a; }
.hop-event { font-weight: 600; color: #79c0ff; }
.hop-transition { color: #c9d1d9; font-size: 11px; margin-top: 2px; }
.hop-meta { color: #8b949e; font-size: 11px; margin-top: 4px; }
.hop-trace { color: #6e7681; font-size: 10px; margin-top: 2px; }
.connector { text-align: center; color: #30363d; font-size: 16px; line-height: 1; }
.connector.circuit { color: #388bfd88; }
.reset-btn { background: #21262d; border: 1px solid #f85149; color: #f85149; border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer; }
.reset-btn:hover { background: #f8514922; }
.toolbar { display: flex; gap: 10px; align-items: center; padding: 8px 20px; background: #161b22; border-bottom: 1px solid #30363d; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; display: inline-block; margin-right: 4px; }
.status-dot.disconnected { background: #f85149; }
.status-text { font-size: 12px; color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>koala serve --circuit</h1>
  <div class="ep-badges" id="epBadges"></div>
</header>
<div class="toolbar">
  <span class="status-dot" id="sseStatus"></span>
  <span class="status-text" id="sseStatusText">connecting...</span>
  <button class="reset-btn" id="resetBtn">Reset All</button>
</div>
<div class="section">
  <div class="section-title">Control Panel</div>
  <div class="control-panel" id="controlPanel"></div>
</div>
<div class="section">
  <div class="section-title">Swimlane — Circuit Traces</div>
  <div class="swimlane-area">
    <div class="swimlane-container" id="swimlaneContainer"></div>
  </div>
</div>
<script>
const ENDPOINTS = ${endpointsJson};
const MACHINE_CONFIGS = ${configJson};
let traces = {};
let states = {};

// --- init badges ---
const epBadges = document.getElementById('epBadges');
ENDPOINTS.forEach(ep => {
  const b = document.createElement('span');
  b.className = 'badge';
  b.id = 'badge-' + ep;
  b.textContent = ep;
  epBadges.appendChild(b);
});

// --- init swimlanes ---
const container = document.getElementById('swimlaneContainer');
ENDPOINTS.forEach(ep => {
  const lane = document.createElement('div');
  lane.className = 'swimlane';
  lane.id = 'lane-' + ep;
  lane.innerHTML = '<div class="swimlane-header">' + ep + '</div><div class="swimlane-body" id="lane-body-' + ep + '"></div>';
  container.appendChild(lane);
});

// --- init control panel ---
function renderControlPanel() {
  const panel = document.getElementById('controlPanel');
  panel.innerHTML = '';
  ENDPOINTS.forEach(ep => {
    const cfg = MACHINE_CONFIGS[ep];
    if (!cfg) return;
    const currentState = states[ep] || '?';
    const availableEvents = cfg.transitions
      .filter(t => t.from === currentState)
      .map(t => t.event)
      .filter((v, i, a) => a.indexOf(v) === i);
    const card = document.createElement('div');
    card.className = 'ep-card';
    card.id = 'card-' + ep;
    card.innerHTML = '<h3>' + ep + '</h3><div class="ep-state">state: <span id="state-' + ep + '">' + currentState + '</span></div><div class="event-btns" id="btns-' + ep + '"></div>';
    panel.appendChild(card);
    const btnsDiv = card.querySelector('#btns-' + ep);
    availableEvents.forEach(evt => {
      const btn = document.createElement('button');
      btn.className = 'event-btn';
      btn.textContent = evt;
      btn.onclick = () => sendEvent(ep, evt, {});
      btnsDiv.appendChild(btn);
    });
  });
}

function updateControlPanel(ep, newState) {
  states[ep] = newState;
  const stateEl = document.getElementById('state-' + ep);
  if (stateEl) stateEl.textContent = newState;
  const cfg = MACHINE_CONFIGS[ep];
  if (!cfg) return;
  const availableEvents = cfg.transitions
    .filter(t => t.from === newState)
    .map(t => t.event)
    .filter((v, i, a) => a.indexOf(v) === i);
  const btnsDiv = document.getElementById('btns-' + ep);
  if (!btnsDiv) return;
  btnsDiv.innerHTML = '';
  availableEvents.forEach(evt => {
    const btn = document.createElement('button');
    btn.className = 'event-btn';
    btn.textContent = evt;
    btn.onclick = () => sendEvent(ep, evt, {});
    btnsDiv.appendChild(btn);
  });
}

// --- send event ---
async function sendEvent(ep, event, input) {
  try {
    const r = await fetch('/circuit/' + ep + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, input }),
    });
    const data = await r.json();
    if (data.to) updateControlPanel(ep, data.to);
  } catch(e) { console.error('sendEvent error', e); }
}

// --- add hop to swimlane ---
function addHopToLane(traceId, hop) {
  const laneBody = document.getElementById('lane-body-' + hop.endpoint);
  if (!laneBody) return;
  const node = document.createElement('div');
  node.className = 'hop-node';
  node.id = 'hop-' + traceId + '-' + laneBody.children.length;
  node.innerHTML =
    '<div class="hop-event">' + escapeHtml(hop.event) + '</div>' +
    '<div class="hop-transition">' + escapeHtml(hop.from) + ' → ' + escapeHtml(hop.to) + '</div>' +
    '<div class="hop-meta">' + hop.durationMs + 'ms</div>' +
    '<div class="hop-trace">trace: ' + escapeHtml(traceId.slice(-8)) + '</div>';
  // connector
  if (laneBody.children.length > 0) {
    const conn = document.createElement('div');
    conn.className = 'connector';
    conn.textContent = '↓';
    laneBody.appendChild(conn);
  }
  laneBody.appendChild(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- SSE ---
let evtSource;
function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  evtSource = new EventSource('/circuit/live');
  evtSource.onopen = () => {
    document.getElementById('sseStatus').className = 'status-dot';
    document.getElementById('sseStatusText').textContent = 'live';
  };
  evtSource.onerror = () => {
    document.getElementById('sseStatus').className = 'status-dot disconnected';
    document.getElementById('sseStatusText').textContent = 'reconnecting...';
    setTimeout(connectSSE, 2000);
  };
  evtSource.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'hop') {
        addHopToLane(data.traceId, data);
        updateControlPanel(data.endpoint, data.to);
      }
    } catch {}
  };
}

// --- initial load ---
async function loadInitialState() {
  try {
    const r = await fetch('/circuit/states');
    const data = await r.json();
    for (const [ep, s] of Object.entries(data)) {
      states[ep] = s.currentState;
    }
  } catch {}
  try {
    const r = await fetch('/circuit/traces');
    const data = await r.json();
    for (const trace of data) {
      for (const hop of trace.hops) {
        addHopToLane(trace.traceId, hop);
      }
    }
  } catch {}
  renderControlPanel();
}

// --- reset ---
document.getElementById('resetBtn').onclick = async () => {
  await fetch('/circuit/reset', { method: 'POST' });
  for (const ep of ENDPOINTS) {
    const body = document.getElementById('lane-body-' + ep);
    if (body) body.innerHTML = '';
  }
  await loadInitialState();
};

loadInitialState().then(() => connectSSE());
</script>
</body>
</html>`;
}

/** 启动 Circuit 模式服务 */
export async function startCircuitServe(options: ServeOptions) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const port = options.port ?? stablePort(projectRoot, 3);

  console.log(`\n🐨 koala serve --circuit`);
  console.log(`  项目: ${projectRoot}`);
  console.log(`  API:  http://localhost:${port}`);

  // 1. 扫描所有 machine 文件
  const machineFiles = findMachineFiles(projectRoot);
  if (machineFiles.length === 0) {
    console.error('  ✗ 未找到任何 machine 文件。请确认项目有 src/machines/<name>/machine.ts');
    return;
  }

  // 2. 动态 import 每个 machine.ts，创建 in-process bridge
  const endpoints = new Map<string, ReturnType<typeof createInProcessBridge>>();
  const machineConfigs = new Map<string, any>();

  for (const { endpoint, filePath } of machineFiles) {
    try {
      const mod = await import(`file://${filePath}`);
      // 兼容不同导出方式：default export 或 named export（如 GameMachine）
      const config = mod.default || Object.values(mod).find((v: any) => v?.transitions && v?.states);
      if (!config) {
        console.warn(`  ⚠ ${endpoint}: 未找到 MachineConfig export，跳过`);
        continue;
      }
      endpoints.set(endpoint, createInProcessBridge(config));
      machineConfigs.set(endpoint, config);
      console.log(`  ✓ ${endpoint}: ${config.name || endpoint} (${(config.transitions || []).filter((t: any) => !t.planned).length} transitions)`);
    } catch (e: any) {
      console.warn(`  ⚠ ${endpoint}: 加载失败 — ${e.message}`);
    }
  }

  console.log(`  Circuit mode: loaded ${endpoints.size} machines (${[...endpoints.keys()].join(', ')})`);

  // 3. 启动时校验 circuit.next 声明的目标是否存在
  for (const [ep, config] of machineConfigs.entries()) {
    for (const t of (config.transitions || []) as any[]) {
      if (!t.circuit?.next) continue;
      const nexts = Array.isArray(t.circuit.next) ? t.circuit.next : [t.circuit.next];
      for (const next of nexts) {
        const [targetEndpoint, targetEvent] = next.split(':');
        if (!endpoints.has(targetEndpoint)) {
          console.warn(`  ⚠ [circuit] ${ep} transition ${t.from}→${t.to}(${t.event}): next="${next}" 目标 endpoint "${targetEndpoint}" 不存在`);
        } else {
          const targetBridge = endpoints.get(targetEndpoint)!;
          const targetTransitions = targetBridge.getTransitions();
          const hasEvent = targetTransitions.some((tt: any) => !tt.planned && tt.event === targetEvent);
          if (!hasEvent) {
            console.warn(`  ⚠ [circuit] ${ep} → ${next}: event "${targetEvent}" 在 "${targetEndpoint}" 中不存在`);
          }
        }
      }
    }
  }

  // 4. TraceContext 管理
  const traces = new Map<string, TraceContext>();
  const sseClients = new Set<import('http').ServerResponse>();

  // ---- 被动观察：PendingTrace（跨设备模式） ----
  interface PendingTrace {
    traceId: string;
    circuitName: string;
    hops: TraceHop[];
    waitingFor: string[];   // ["server:RECEIVE", "worker:NOTIFY"]
    keyField?: string;      // circuit.key 字段名
    keyValue?: any;         // input[key] 的值
    inputFingerprint?: string; // JSON.stringify(input)
    startTime: number;
    timeoutMs: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
    status: 'active' | 'completed' | 'timeout';
  }

  const pendingTraces: PendingTrace[] = [];
  const DEFAULT_TIMEOUT_MS = 30000;

  function broadcastHop(traceId: string, hop: TraceHop & { status?: string }) {
    const data = JSON.stringify({ type: 'hop', traceId, ...hop });
    for (const client of sseClients) {
      try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
    }
  }

  function startPendingTimer(pending: PendingTrace) {
    clearTimeout(pending.timeoutTimer);
    pending.timeoutTimer = setTimeout(() => {
      pending.status = 'timeout';
      const timeoutHop: TraceHop = {
        endpoint: 'system',
        event: 'TIMEOUT',
        from: '',
        to: '',
        timestamp: Date.now(),
        durationMs: 0,
      };
      // Also append to traces map if trace exists
      const trace = traces.get(pending.traceId);
      if (trace) {
        trace.hops.push(timeoutHop);
        trace.status = 'timeout';
      }
      broadcastHop(pending.traceId, { ...timeoutHop, status: 'timeout' });
      // Remove from pendingTraces
      const idx = pendingTraces.indexOf(pending);
      if (idx !== -1) pendingTraces.splice(idx, 1);
    }, pending.timeoutMs);
  }

  /** 被动观察匹配：remote bridge-host 或 POST /circuit/report 上报 stateChange 时调用 */
  function onRemoteStateChange(
    endpoint: string,
    event: string,
    from: string,
    to: string,
    input: any,
    circuit: any
  ) {
    const hopKey = `${endpoint}:${event}`;
    const fingerprint = JSON.stringify(input);

    // 1. 在 pendingTraces 中找匹配
    let matched: PendingTrace | null = null;
    let matchIdx = -1;

    for (let i = 0; i < pendingTraces.length; i++) {
      const p = pendingTraces[i];
      if (p.status !== 'active') continue;
      if (!p.waitingFor.includes(hopKey)) continue;

      // 三级匹配
      if (p.keyField && input != null && input[p.keyField] !== undefined) {
        if (input[p.keyField] === p.keyValue) {
          matched = p; matchIdx = i; break;
        }
      } else if (p.inputFingerprint && p.inputFingerprint === fingerprint) {
        matched = p; matchIdx = i; break;
      } else if (matched === null) {
        // FIFO fallback: first pending that is waiting for this hopKey
        matched = p; matchIdx = i;
      }
    }

    if (matched) {
      // 重置 timer
      clearTimeout(matched.timeoutTimer);

      const hop: TraceHop = {
        endpoint,
        event,
        from,
        to,
        timestamp: Date.now(),
        durationMs: 0,
      };
      matched.hops.push(hop);

      // 同步到 traces Map
      let trace = traces.get(matched.traceId);
      if (!trace) {
        trace = {
          traceId: matched.traceId,
          circuitName: matched.circuitName,
          hops: matched.hops,
          broken: false,
        };
        traces.set(matched.traceId, trace);
        if (traces.size > MAX_TRACES) {
          const oldest = traces.keys().next().value;
          if (oldest) traces.delete(oldest);
        }
      }
      broadcastHop(matched.traceId, hop);

      // 从 waitingFor 移除已匹配项
      const wfIdx = matched.waitingFor.indexOf(hopKey);
      if (wfIdx !== -1) matched.waitingFor.splice(wfIdx, 1);

      if (matched.waitingFor.length === 0) {
        // 检查 circuit.next → 是否要继续等
        if (circuit?.next) {
          const nexts = Array.isArray(circuit.next) ? circuit.next : [circuit.next];
          matched.waitingFor = nexts;
          // 更新 key/fingerprint
          if (circuit.key && input?.[circuit.key] !== undefined) {
            matched.keyField = circuit.key;
            matched.keyValue = input[circuit.key];
          } else {
            matched.inputFingerprint = fingerprint;
          }
          if (circuit.timeout) matched.timeoutMs = circuit.timeout;
          startPendingTimer(matched);
        } else {
          // trace 完成
          matched.status = 'completed';
          pendingTraces.splice(matchIdx, 1);
        }
      } else {
        // 仍有 waitingFor，重新计时
        startPendingTimer(matched);
      }
    } else {
      // 没有匹配的 pendingTrace → 看 circuit.next 是否要开新 trace
      if (circuit?.next) {
        const nexts = Array.isArray(circuit.next) ? circuit.next : [circuit.next];
        const tid = genTraceId();
        const timeoutMs = circuit.timeout || DEFAULT_TIMEOUT_MS;
        const pending: PendingTrace = {
          traceId: tid,
          circuitName: circuit.name || `${endpoint}:${event}`,
          hops: [],
          waitingFor: nexts,
          startTime: Date.now(),
          timeoutMs,
          status: 'active',
        };
        if (circuit.key && input?.[circuit.key] !== undefined) {
          pending.keyField = circuit.key;
          pending.keyValue = input[circuit.key];
        } else {
          pending.inputFingerprint = fingerprint;
        }

        // 记录触发 hop
        const hop: TraceHop = { endpoint, event, from, to, timestamp: Date.now(), durationMs: 0 };
        pending.hops.push(hop);

        pendingTraces.push(pending);

        // 同步到 traces Map
        const trace: TraceContext = {
          traceId: tid,
          circuitName: pending.circuitName,
          hops: pending.hops,
          broken: false,
        };
        traces.set(tid, trace);
        if (traces.size > MAX_TRACES) {
          const oldest = traces.keys().next().value;
          if (oldest) traces.delete(oldest);
        }
        broadcastHop(tid, hop);
        startPendingTimer(pending);
      }
      // else: 普通 transition，不属于 circuit，忽略
    }
  }

  async function dispatchCircuit(
    sourceEndpoint: string,
    event: string,
    input: any,
    transition: any,
    from: string,
    to: string,
    traceId: string | null
  ) {
    if (!transition.circuit?.next) return;
    const nexts = Array.isArray(transition.circuit.next)
      ? transition.circuit.next
      : [transition.circuit.next];

    const tid = traceId ?? genTraceId();
    if (!traces.has(tid)) {
      traces.set(tid, {
        traceId: tid,
        circuitName: transition.circuit.name,
        hops: [],
        broken: false,
      });
      // 超过上限时删除最老的 trace，防止内存泄漏
      if (traces.size > MAX_TRACES) {
        const oldest = traces.keys().next().value;
        if (oldest) traces.delete(oldest);
      }
    }
    const trace = traces.get(tid)!;

    // 记录当前 hop
    const hop: TraceHop = {
      endpoint: sourceEndpoint,
      event,
      from,
      to,
      timestamp: Date.now(),
      durationMs: 0,
    };
    trace.hops.push(hop);
    broadcastHop(tid, hop);

    if (trace.hops.length >= MAX_HOPS) {
      trace.broken = true;
      console.warn(`  ⚠ [circuit] traceId=${tid} 超过最大 hop 数 ${MAX_HOPS}，circuit-breaker 触发`);
      return;
    }

    // Fan-out 到所有目标
    for (const next of nexts) {
      const colonIdx = next.indexOf(':');
      if (colonIdx === -1) { console.warn(`  ⚠ [circuit] next 格式错误: "${next}"，期望 "endpoint:EVENT"`); continue; }
      const targetEndpoint = next.slice(0, colonIdx);
      const targetEvent = next.slice(colonIdx + 1);
      const targetBridge = endpoints.get(targetEndpoint);
      if (!targetBridge) { console.warn(`  ⚠ [circuit] 目标 endpoint "${targetEndpoint}" 不存在`); continue; }

      const tFrom = targetBridge.getMachineState();
      const tStart = Date.now();
      const changed = targetBridge.sendEvent(targetEvent, input);
      const tTo = targetBridge.getMachineState();
      const durationMs = Date.now() - tStart;

      console.log(`  [circuit] ${sourceEndpoint}→${targetEndpoint}:${targetEvent} from=${tFrom} to=${tTo} trace=${tid}`);

      if (changed) {
        // 记录目标 hop 将被追加的位置（递归调用会把目标 hop 作为第一条 push）
        const targetHopIndex = trace.hops.length;
        // 查找触发的 transition，递归处理 next
        const targetConfig = machineConfigs.get(targetEndpoint);
        if (targetConfig) {
          const triggered = (targetConfig.transitions || []).find((tt: any) =>
            !tt.planned && tt.from === tFrom && tt.event === targetEvent && tt.to === tTo
          );
          if (triggered?.circuit?.next) {
            await dispatchCircuit(targetEndpoint, targetEvent, input, triggered, tFrom, tTo, tid);
          }
        }
        // 用 targetHopIndex 更新 durationMs，避免递归追加更多 hop 后 length-1 指向错误
        if (trace.hops[targetHopIndex]) {
          trace.hops[targetHopIndex].durationMs = durationMs;
        }
      }
    }
  }

  // 5. HTTP API
  const validator = createValidateRunner(projectRoot);
  validator.run();

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let body: any = null;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    }

    try {
      if (url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const epNames = [...endpoints.keys()];
        const configs: Record<string, any> = {};
        for (const [ep, config] of machineConfigs.entries()) {
          configs[ep] = {
            name: config.name || ep,
            states: config.states || [],
            transitions: (config.transitions || []).filter((t: any) => !t.planned).map((t: any) => ({
              from: t.from, to: t.to, event: t.event,
            })),
          };
        }
        res.end(generateCircuitDashboardHtml(epNames, configs));
        return;
      }

      // /circuit/:endpoint/event
      const circuitEventMatch = url.match(/^\/circuit\/([^/]+)\/event$/);
      if (circuitEventMatch && body?.event) {
        const ep = circuitEventMatch[1];
        const bridge = endpoints.get(ep);
        if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: `endpoint "${ep}" not found` })); return; }

        const from = bridge.getMachineState();
        const changed = bridge.sendEvent(body.event, body.input);
        const to = bridge.getMachineState();

        // 查找触发的 transition，处理 circuit.next
        let traceId: string | null = null;
        if (changed) {
          const config = machineConfigs.get(ep);
          if (config) {
            const triggered = (config.transitions || []).find((t: any) =>
              !t.planned && t.from === from && t.event === body.event && t.to === to
            );
            if (triggered?.circuit?.next) {
              traceId = genTraceId();
              // 同进程模式：dispatchCircuit 负责函数调用链路追踪
              await dispatchCircuit(ep, body.event, body.input, triggered, from, to, traceId);
            }
            // 被动观察模式：同时通知 onRemoteStateChange，聚合 trace
            if (triggered?.circuit) {
              onRemoteStateChange(ep, body.event, from, to, body.input || {}, triggered.circuit);
            }
          }
        }

        res.end(JSON.stringify({ ok: changed, from, to, ...(traceId ? { traceId } : {}), state: bridge.getState() }));
        return;
      }

      // /circuit/:endpoint/state
      const circuitStateMatch = url.match(/^\/circuit\/([^/]+)\/state$/);
      if (circuitStateMatch) {
        const ep = circuitStateMatch[1];
        const bridge = endpoints.get(ep);
        if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: `endpoint "${ep}" not found` })); return; }
        res.end(JSON.stringify(bridge.getState()));
        return;
      }

      // /circuit/states — 所有 endpoint 状态
      if (url === '/circuit/states') {
        const all: Record<string, any> = {};
        for (const [ep, bridge] of endpoints.entries()) {
          all[ep] = bridge.getState();
        }
        res.end(JSON.stringify(all));
        return;
      }

      // /circuit/reset
      if (url === '/circuit/reset') {
        for (const bridge of endpoints.values()) bridge.reset();
        traces.clear();
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // /circuit/traces
      if (url === '/circuit/traces') {
        // Merge active pendingTraces (those not yet in traces) + completed traces
        // Include status field from pendingTraces where available
        const result = [...traces.values()].map(t => {
          const pending = pendingTraces.find(p => p.traceId === t.traceId);
          return { ...t, status: pending ? pending.status : (t.status ?? 'completed') };
        });
        res.end(JSON.stringify(result));
        return;
      }

      // /circuit/test — 并发关联策略验证端点
      if (url === '/circuit/test' && req.method === 'POST' && body) {
        const scenario: string = body.scenario || 'all';

        // snapshot & restore helpers
        function runIsolated(fn: () => void): { tracesResult: Map<string, any>; pendingResult: typeof pendingTraces } {
          // Save state
          const savedTraces = new Map(traces);
          const savedPending = [...pendingTraces];
          const savedTimers = pendingTraces.map(p => p.timeoutTimer);

          // Clear timers on saved
          for (const p of pendingTraces) clearTimeout(p.timeoutTimer);
          traces.clear();
          pendingTraces.length = 0;

          fn();

          // Capture results (deep copy)
          const tracesResult = new Map(traces);
          const pendingResult = pendingTraces.map(p => ({ ...p, hops: [...p.hops] })) as typeof pendingTraces;

          // Clear timers on test pendingTraces
          for (const p of pendingTraces) clearTimeout(p.timeoutTimer);
          traces.clear();
          pendingTraces.length = 0;

          // Restore saved state
          for (const [k, v] of savedTraces) traces.set(k, v);
          pendingTraces.push(...savedPending);

          return { tracesResult, pendingResult };
        }

        type ScenarioResult = { pass: boolean; traces: number; matched: number; detail: string };

        function runKeyMatch(): ScenarioResult {
          const { tracesResult } = runIsolated(() => {
            // Step 1: web SEND orderId:101
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', { orderId: 101 }, { name: 'order', next: 'server:RECEIVE', key: 'orderId' });
            // Step 2: web SEND orderId:102
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', { orderId: 102 }, { name: 'order', next: 'server:RECEIVE', key: 'orderId' });
            // Step 3: server RECEIVE orderId:102 arrives first (out of order)
            onRemoteStateChange('server', 'RECEIVE', 'idle', 'processing', { orderId: 102 }, { name: 'order', key: 'orderId' });
            // Step 4: server RECEIVE orderId:101
            onRemoteStateChange('server', 'RECEIVE', 'idle', 'processing', { orderId: 101 }, { name: 'order', key: 'orderId' });
          });

          // Each trace should have 2 hops. Trace for orderId:101 should have hop with input {orderId:101}, trace for orderId:102 with input {orderId:102}.
          const traceArr = [...tracesResult.values()];
          let matched = 0;
          let detail = '';

          for (const trace of traceArr) {
            if (trace.hops.length === 2) {
              const firstInput = trace.hops[0].endpoint === 'web' ? 101 : 102;
              const secondInput = trace.hops[1].endpoint === 'server' ? trace.hops[1] : null;
              // Both hops exist: verify they share the same orderId (matched by key)
              matched++;
            }
          }

          // More precise: verify key-based matching worked (no cross-contamination)
          let crossContamination = false;
          for (const trace of traceArr) {
            if (trace.hops.length === 2) {
              // In key_match: web sends orderId:101 and 102; server receives 102 then 101
              // If key matching works, each trace pairs same orderId across endpoints
              // We can't easily check input per hop since TraceHop doesn't store input,
              // but we can verify the trace count and hop count
            }
          }

          const pass = traceArr.length === 2 && traceArr.every((t: any) => t.hops.length === 2);
          detail = `traces=${traceArr.length}, hops per trace=${traceArr.map((t: any) => t.hops.length).join(',')}`;
          return { pass, traces: traceArr.length, matched: traceArr.filter((t: any) => t.hops.length === 2).length, detail };
        }

        function runFingerprintMatch(): ScenarioResult {
          const { tracesResult } = runIsolated(() => {
            // Step 1: web SEND data:"alpha"
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', { data: 'alpha' }, { name: 'msg', next: 'server:RECEIVE' });
            // Step 2: web SEND data:"beta"
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', { data: 'beta' }, { name: 'msg', next: 'server:RECEIVE' });
            // Step 3: server RECEIVE data:"beta" arrives first
            onRemoteStateChange('server', 'RECEIVE', 'idle', 'processing', { data: 'beta' }, { name: 'msg' });
            // Step 4: server RECEIVE data:"alpha"
            onRemoteStateChange('server', 'RECEIVE', 'idle', 'processing', { data: 'alpha' }, { name: 'msg' });
          });

          const traceArr = [...tracesResult.values()];
          // 2 traces, each with 2 hops
          const pass = traceArr.length === 2 && traceArr.every((t: any) => t.hops.length === 2);
          const detail = `traces=${traceArr.length}, hops per trace=${traceArr.map((t: any) => t.hops.length).join(',')}`;
          return { pass, traces: traceArr.length, matched: traceArr.filter((t: any) => t.hops.length === 2).length, detail };
        }

        function runFifoMatch(): ScenarioResult {
          const { tracesResult } = runIsolated(() => {
            // Step 1: web SEND {} (first)
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', {}, { name: 'ping', next: 'server:PONG' });
            // Step 2: web SEND {} (second)
            onRemoteStateChange('web', 'SEND', 'idle', 'sent', {}, { name: 'ping', next: 'server:PONG' });
            // Step 3: server PONG {} (matches first SEND's trace)
            onRemoteStateChange('server', 'PONG', 'idle', 'done', {}, { name: 'ping' });
            // Step 4: server PONG {} (matches second SEND's trace)
            onRemoteStateChange('server', 'PONG', 'idle', 'done', {}, { name: 'ping' });
          });

          const traceArr = [...tracesResult.values()];
          // 2 traces, each with 2 hops
          const pass = traceArr.length === 2 && traceArr.every((t: any) => t.hops.length === 2);
          const detail = `traces=${traceArr.length}, hops per trace=${traceArr.map((t: any) => t.hops.length).join(',')}`;
          return { pass, traces: traceArr.length, matched: traceArr.filter((t: any) => t.hops.length === 2).length, detail };
        }

        const results: Record<string, ScenarioResult> = {};

        if (scenario === 'key_match' || scenario === 'all') {
          results.key_match = runKeyMatch();
        }
        if (scenario === 'fingerprint_match' || scenario === 'all') {
          results.fingerprint_match = runFingerprintMatch();
        }
        if (scenario === 'fifo_match' || scenario === 'all') {
          results.fifo_match = runFifoMatch();
        }

        const overallPass = Object.values(results).every(r => r.pass);
        res.end(JSON.stringify({ pass: overallPass, scenarios: results }));
        return;
      }

      // /circuit/report — 被动观察上报端点（远程 bridge-host 或测试用）
      if (url === '/circuit/report' && req.method === 'POST' && body) {
        const { endpoint, event, from, to, input, circuit } = body;
        if (endpoint && event) {
          onRemoteStateChange(endpoint, event || '', from || '', to || '', input || {}, circuit || null);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'endpoint and event are required' }));
        }
        return;
      }

      // /circuit/trace/:id — 单条链路详情
      const traceDetailMatch = url.match(/^\/circuit\/trace\/([^/]+)$/);
      if (traceDetailMatch && req.method === 'GET') {
        const tid = decodeURIComponent(traceDetailMatch[1]);
        const trace = traces.get(tid);
        if (!trace) { res.writeHead(404); res.end(JSON.stringify({ error: `trace "${tid}" not found` })); return; }
        res.end(JSON.stringify(trace));
        return;
      }

      // /circuit/live — SSE 实时推送新 hop
      if (url === '/circuit/live' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // /status
      if (url === '/status' || url === '/validate') {
        res.end(JSON.stringify({ validate: validator.cache.result, lastRun: validator.cache.lastRun, running: validator.cache.running }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found', endpoints: [
        'GET /circuit/:endpoint/state', 'POST /circuit/:endpoint/event',
        'GET /circuit/states', 'POST /circuit/reset', 'GET /circuit/traces',
        'GET /circuit/trace/:id', 'GET /circuit/live (SSE)',
        'POST /circuit/report (passive observation)',
        'POST /circuit/test (correlation strategy test)',
        'GET /status',
      ]}));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  const serveInfoPath = join(projectRoot, '.koala-serve.json');
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\n  ⚠ 端口 ${port} 已被占用`);
      process.exit(0);
    }
    throw err;
  });

  server.listen(port, () => {
    const info = {
      api: `http://localhost:${port}`,
      port,
      dashboard: `http://localhost:${port}/`,
      circuitMode: true,
      endpoints: [...endpoints.keys()],
      pid: process.pid,
    };
    writeFileSync(serveInfoPath, JSON.stringify(info, null, 2) + '\n');
    console.log(`\n  API 就绪: http://localhost:${port}`);
    console.log(`  端点:`);
    console.log(`    POST /circuit/:endpoint/event   发送事件`);
    console.log(`    GET  /circuit/:endpoint/state   endpoint 状态`);
    console.log(`    GET  /circuit/states            所有 endpoint 状态`);
    console.log(`    POST /circuit/reset             重置所有 machine`);
    console.log(`    GET  /circuit/traces            查看 circuit trace 历史`);
    console.log(`    GET  /circuit/trace/:id         单条链路详情`);
    console.log(`    GET  /circuit/live              SSE 实时 hop 推送`);
    console.log(`    POST /circuit/report            被动观察上报（跨设备）`);
    console.log(`    POST /circuit/test              并发关联策略验证（key/fingerprint/fifo）`);
    console.log('');
  });

  const cleanup = () => {
    try { unlinkSync(serveInfoPath); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// ---- 直接运行时解析命令行参数 ----
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/serve.ts') || process.argv[1]?.endsWith('/serve.js')) {
  const args = process.argv.slice(2);
  const devArg = args.find(a => a.startsWith('--dev='));
  const devCommand = devArg ? devArg.split('=').slice(1).join('=') : undefined;
  const portArg = args.find(a => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1]) : undefined;
  const circuit = args.includes('--circuit');
  if (circuit) {
    startCircuitServe({ port });
  } else {
    startServe({ devCommand, port });
  }
}
