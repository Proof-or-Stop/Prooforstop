/**
 * 浏览器端 WebSocket 客户端
 * 由 vite plugin 注入到页面，连接 test-ws-server
 * 接收命令 → 执行 → 返回结果
 */

const WS_PORT = (window as any).__KOALA_WS_PORT || 9876;
const WS_URL = `ws://${location.hostname}:${WS_PORT}`;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[web-test] connected to test server');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = async (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { id, type } = msg;
    let response: any;

    try {
      switch (type) {
        case 'eval':
          response = await handleEval(msg.code);
          break;
        case 'screenshot':
          response = await handleScreenshot();
          break;
        case 'click':
          response = handleClick(msg);
          break;
        case 'type':
          response = handleType(msg);
          break;
        case 'close':
          // 被新客户端踢掉：标记 + 停止重连 + 关闭 tab
          (window as any).__koala_kicked = true;
          if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
          ws?.close();
          ws = null;
          try { window.close(); } catch {}
          return; // 不回复
        default:
          response = { ok: false, error: `unknown command: ${type}` };
      }
    } catch (e: any) {
      response = { ok: false, error: e.message };
    }

    ws?.send(JSON.stringify({ id, ...response }));
  };

  ws.onclose = () => {
    if ((window as any).__koala_kicked) return; // 被踢掉的 tab 不重连
    console.log('[web-test] disconnected, reconnecting...');
    ws = null;
    if (!reconnectTimer) {
      reconnectTimer = window.setInterval(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) connect();
      }, 3000);
    }
  };

  ws.onerror = () => {
    ws?.close();
  };
}

async function handleEval(code: string) {
  try {
    // wrap in async function to support await
    const fn = new Function('return (async () => { return (' + code + ') })()');
    const result = await fn();
    // serialize result
    let serialized: any;
    try {
      serialized = JSON.parse(JSON.stringify(result));
    } catch {
      serialized = String(result);
    }
    return { ok: true, result: serialized };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function handleScreenshot(): Promise<any> {
  // use html2canvas if available, otherwise capture canvas elements
  const canvas = document.querySelector('canvas');
  if (canvas) {
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    return { ok: true, data: base64 };
  }
  // fallback: try html2canvas
  if ((window as any).html2canvas) {
    const c = await (window as any).html2canvas(document.body);
    const dataUrl = c.toDataURL('image/png');
    return { ok: true, data: dataUrl.split(',')[1] };
  }
  return { ok: false, error: 'No canvas found and html2canvas not available. For full page screenshots, add html2canvas to your project.' };
}

function handleClick(msg: any) {
  if (msg.selector) {
    const el = document.querySelector(msg.selector) as HTMLElement;
    if (!el) return { ok: false, error: `element not found: ${msg.selector}` };
    el.click();
    return { ok: true };
  }
  if (msg.x !== undefined && msg.y !== undefined) {
    const target = document.elementFromPoint(msg.x, msg.y) as HTMLElement;
    if (!target) return { ok: false, error: `no element at (${msg.x}, ${msg.y})` };
    // for canvas, dispatch mouse events with coordinates
    const rect = target.getBoundingClientRect();
    const events = ['mousedown', 'mouseup', 'click'];
    for (const evtName of events) {
      target.dispatchEvent(new MouseEvent(evtName, {
        bubbles: true,
        clientX: msg.x,
        clientY: msg.y,
      }));
    }
    return { ok: true };
  }
  return { ok: false, error: 'need selector or x/y coordinates' };
}

function handleType(msg: any) {
  const el = msg.selector
    ? document.querySelector(msg.selector) as HTMLInputElement
    : document.activeElement as HTMLInputElement;
  if (!el) return { ok: false, error: 'no target element' };
  el.focus();
  if ('value' in el) {
    el.value = msg.text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true };
}

// 全局错误捕获 — 通过 WS 发回给调试端
const _errors: string[] = [];

window.addEventListener('error', (e) => {
  const msg = `[error] ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`;
  _errors.push(msg);
  console.error('[web-test]', msg);
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = `[unhandledrejection] ${e.reason}`;
  _errors.push(msg);
  console.error('[web-test]', msg);
});

// 暴露给 eval 查询
(window as any).__webtest_errors = _errors;

// trace 由代理在函数体内注入，client.js 不再做 Proxy 包装

// auto-connect
connect();
