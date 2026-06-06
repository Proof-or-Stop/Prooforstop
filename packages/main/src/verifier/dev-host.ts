/**
 * dev-host.ts — debug host provided by the framework
 *
 * The project's debug.ts only needs to call devHost(createApp, machine),
 * the framework handles: killing old processes → bridge-host → writing the discovery file → cleanup → mounting the shell
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { startBridgeHost } from './bridge-host.js';

interface DevHostOptions {
  bridge: {
    sendEvent(event: string, input: any): any;
    onStateChange(cb: (state: any) => void): () => void;
    getState(): any;
    getMachineState(): string;
    reset(): void;
  };
  [key: string]: any; // Allow the project to return arbitrary extra fields
}

interface MachineInfo {
  name: string;
  states: string[];
  transitions: any[];
}

/** Port hash (consistent with serve.ts / dev-cli.ts) */
function stablePort(s: string, offset: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h + offset * 7919) % 50000);
}

/**
 * Start the debug host
 *
 * @param createApp The project's createApp function (async, returns { bridge, ...project-custom fields })
 * @param machine The project's Machine config (used as metadata for bridge-host)
 */
export async function devHost(
  createApp: () => Promise<DevHostOptions> | DevHostOptions,
  machine: MachineInfo,
): Promise<DevHostOptions> {
  const wsPort = Number(process.env.KOALA_SERVE_PORT || stablePort(process.cwd(), 4));
  const infoPath = '.koala-serve.json';

  // Kill old core
  try {
    const old = JSON.parse(readFileSync(infoPath, 'utf-8'));
    if (old.pid && old.pid !== process.pid) {
      process.kill(old.pid, 'SIGTERM');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 200));
        try { process.kill(old.pid, 0); } catch { break; }
      }
    }
  } catch {}

  // Create app
  const app = await createApp();
  console.log(`[core] ${machine.name} ready`);

  // Start bridge-host
  await startBridgeHost(app.bridge, machine, wsPort);

  // Write discovery file
  writeFileSync(infoPath, JSON.stringify({
    pid: process.pid,
    wsPort,
    projectRoot: process.cwd(),
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  // cleanup
  const cleanup = () => { try { unlinkSync(infoPath); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return app;
}
