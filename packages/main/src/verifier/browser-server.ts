#!/usr/bin/env node
/**
 * verifier/browser-server: WebSocket(:wsPort) + HTTP(:httpPort) bridge server
 * Browser connects via WS, test executor sends commands via HTTP API.
 *
 * Requires `ws` package at runtime.
 */

// @ts-ignore
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const WS_PORT = parseInt(process.env.WS_PORT || '9876');
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '9877');

let browserSocket: WebSocket | null = null;
let pendingRequests = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
let reqIdCounter = 0;

// -- WebSocket Server (browser connects here) --

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws: any) => {
  console.log('[ws] browser connected');
  if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
    try { browserSocket.send(JSON.stringify({ type: 'close' })); } catch {}
    browserSocket.close();
    console.log('[ws] kicked old client');
  }
  browserSocket = ws;

  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(msg);
        pendingRequests.delete(msg.id);
      }
    } catch (e) {
      console.error('[ws] bad message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[ws] browser disconnected');
    if (browserSocket === ws) browserSocket = null;
  });
});

console.log(`[ws] listening on :${WS_PORT}`);

// -- Send command to browser and wait for response --

function sendToBrowser(type: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error('No browser connected'));
    }
    const id = String(++reqIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Timeout waiting for browser response'));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, timer });
    browserSocket.send(JSON.stringify({ id, type, ...payload }));
  });
}

// -- HTTP API Server (executor calls here) --

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

const httpServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = req.url || '/';

  try {
    if (url === '/status' && req.method === 'GET') {
      return json(res, 200, {
        connected: browserSocket?.readyState === WebSocket.OPEN,
        pendingRequests: pendingRequests.size,
      });
    }

    if (url === '/eval' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await sendToBrowser('eval', { code: body.code }, body.timeout || 10000);
      return json(res, 200, result);
    }

    if (url === '/screenshot' && req.method === 'POST') {
      const result = await sendToBrowser('screenshot', {}, 15000);
      if (result.ok && result.data) {
        const buf = Buffer.from(result.data, 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
        });
        return res.end(buf);
      }
      return json(res, 200, result);
    }

    if (url === '/click' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await sendToBrowser('click', body);
      return json(res, 200, result);
    }

    if (url === '/type' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await sendToBrowser('type', body);
      return json(res, 200, result);
    }

    if (url === '/stop' && req.method === 'POST') {
      if (browserSocket) browserSocket.close();
      json(res, 200, { ok: true, message: 'session closed' });
      setTimeout(() => process.exit(0), 500);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e: any) {
    json(res, 500, { ok: false, error: e.message });
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[http] listening on :${HTTP_PORT}`);
  console.log(`[ready] WS=:${WS_PORT} HTTP=:${HTTP_PORT}`);
});
