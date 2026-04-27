/**
 * dev-host.ts — 框架提供的调试宿主
 *
 * 项目的 debug.ts 只需调用 devHost(createApp, machine)，
 * 框架负责：杀旧进程 → bridge-host → 写发现文件 → cleanup → 挂壳
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
  [key: string]: any; // 允许项目返回任意额外字段
}

interface MachineInfo {
  name: string;
  states: string[];
  transitions: any[];
}

/** 端口哈希（和 serve.ts / dev-cli.ts 一致） */
function stablePort(s: string, offset: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h + offset * 7919) % 50000);
}

/**
 * 启动调试宿主
 *
 * @param createApp 项目的 createApp 函数（async，返回 { bridge, ...项目自定义字段 }）
 * @param machine 项目的 Machine 配置（用于 bridge-host 的元数据）
 */
export async function devHost(
  createApp: () => Promise<DevHostOptions> | DevHostOptions,
  machine: MachineInfo,
): Promise<DevHostOptions> {
  const wsPort = Number(process.env.KOALA_SERVE_PORT || stablePort(process.cwd(), 4));
  const infoPath = '.koala-serve.json';

  // 杀旧 core
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

  // 创建 app
  const app = await createApp();
  console.log(`[core] ${machine.name} 就绪`);

  // 启动 bridge-host
  await startBridgeHost(app.bridge, machine, wsPort);

  // 写发现文件
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
