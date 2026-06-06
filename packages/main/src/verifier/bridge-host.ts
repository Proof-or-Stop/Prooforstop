/**
 * bridge-host.ts — generic Bridge WS host
 *
 * Project calls startBridgeHost(bridge, machine, port),
 * the framework's koala serve connects to act as an HTTP→WS proxy.
 *
 * Protocol:
 *   server→client  {type:'init', machine:{name,transitions,...}, state, machineState}
 *   server→client  {type:'stateChange', state, machineState}
 *   client→server  {type:'event', event, input}
 *   client→server  {type:'reset'}
 *   client→server  {type:'getState'}  → server responds {type:'state', state, machineState}
 *   client→server  {type:'getEvents'} → server responds {type:'events', events:[...]}
 */

import { WebSocketServer, WebSocket } from 'ws';
import { execSync } from 'child_process';

export interface BridgeHostBridge {
  sendEvent(event: string, input: any): boolean | void;
  getState(): any;
  getMachineState(): string;
  reset(): void;
}

export interface BridgeHostMachine {
  name: string;
  states: string[];
  transitions: Array<{
    from: string;
    to: string;
    event: string;
    description?: string;
    planned?: boolean;
    inputSchema?: any;
    circuit?: any;
  }>;
}

export async function startBridgeHost(
  bridge: BridgeHostBridge,
  machine: BridgeHostMachine,
  port: number,
): Promise<{ stop: () => void }> {
  // First clean up old processes occupying the port
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`).toString().trim();
    if (pids) {
      execSync(`kill -9 ${pids}`);
      console.log(`  Cleaning up old Bridge Host on port ${port} (pid: ${pids})`);
      // Wait for port to be released
      await new Promise(r => setTimeout(r, 500));
    }
  } catch {}

  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();

  const machineInfo = {
    name: machine.name,
    states: machine.states,
    transitions: machine.transitions.filter(t => !t.planned).map(t => ({
      from: t.from, to: t.to, event: t.event,
      description: t.description || '',
      inputSchema: t.inputSchema || null,
      circuit: t.circuit || null,
    })),
  };

  function broadcastState(eventContext?: { event: string; input: any; circuit?: any }) {
    const msg = JSON.stringify({
      type: 'stateChange',
      state: bridge.getState(),
      machineState: bridge.getMachineState(),
      ...(eventContext ? {
        event: eventContext.event,
        input: eventContext.input,
        circuit: eventContext.circuit,
      } : {}),
    });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Poll for state changes (fallback when bridge has no onChange callback)
  let lastStateJson = '';
  const poller = setInterval(() => {
    const json = JSON.stringify(bridge.getState());
    if (json !== lastStateJson) {
      lastStateJson = json;
      broadcastState();
    }
  }, 50);

  wss.on('connection', (ws) => {
    clients.add(ws);

    // New connection: send init (includes machine metadata + current state)
    ws.send(JSON.stringify({
      type: 'init',
      machine: machineInfo,
      state: bridge.getState(),
      machineState: bridge.getMachineState(),
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event') {
          const from = bridge.getMachineState();
          const handled = bridge.sendEvent(msg.event, msg.input) !== false;
          const to = bridge.getMachineState();
          if (from !== to) {
            const triggered = machineInfo.transitions.find(t =>
              t.from === from && t.event === msg.event && t.to === to
            );
            broadcastState({ event: msg.event, input: msg.input, circuit: triggered?.circuit || null });
          }
          ws.send(JSON.stringify({
            type: 'eventResult',
            ok: handled,
            from, to,
            state: bridge.getState(),
            error: handled ? undefined : `no matching transition for "${msg.event}" in "${from}"`,
          }));
        } else if (msg.type === 'reset') {
          bridge.reset();
          broadcastState();
        } else if (msg.type === 'getState') {
          ws.send(JSON.stringify({
            type: 'state',
            state: bridge.getState(),
            machineState: bridge.getMachineState(),
          }));
        } else if (msg.type === 'getEvents') {
          const current = bridge.getMachineState();
          const events = machineInfo.transitions
            .filter(t => t.from === current)
            .map(t => ({ event: t.event, to: t.to, description: t.description, inputSchema: t.inputSchema }));
          ws.send(JSON.stringify({ type: 'events', events }));
        }
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  function stop() {
    clearInterval(poller);
    wss.close();
  }

  console.log(`  Bridge Host: ws://localhost:${port} (${machine.name})`);

  return { stop };
}
