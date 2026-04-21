/**
 * bridge-utils.ts — 框架提供的 bridge 自动选择工具
 *
 * 浏览器端：自动 fetch /.koala-serve.json 检测是否有 core 进程
 *   - 有 wsPort → 用 wsFactory 连 WS（开发模式）
 *   - 没有 → 用 localFactory 直连（正式/发布模式）
 * Node.js 端：直接用 localFactory
 */

export interface CreateBridgeOptions<T> {
  /** 本地 bridge 工厂（同进程直连） */
  localFactory: () => T;
  /** WS bridge 工厂（开发模式，连 core 进程） */
  wsFactory?: (wsUrl: string) => T;
}

export async function createBridge<T>(
  options: CreateBridgeOptions<T>,
): Promise<{ bridge: T; isRemote: boolean }> {
  if (typeof window !== 'undefined' && options.wsFactory) {
    try {
      const resp = await fetch('/.koala-serve.json');
      if (resp.ok) {
        const info = await resp.json();
        if (info.wsPort) {
          const bridge = options.wsFactory(`ws://localhost:${info.wsPort}`);
          return { bridge, isRemote: true };
        }
      }
    } catch { /* dev server not running, fall through to local */ }
  }
  return { bridge: options.localFactory(), isRemote: false };
}
