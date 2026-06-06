/**
 * bridge-utils.ts — bridge auto-selection utility provided by the framework
 *
 * Browser side: automatically fetch /.koala-serve.json to detect whether a core process exists
 *   - has wsPort → use wsFactory to connect via WS (development mode)
 *   - none → use localFactory for direct connection (production/release mode)
 * Node.js side: use localFactory directly
 */

export interface CreateBridgeOptions<T> {
  /** Local bridge factory (same-process direct connection) */
  localFactory: () => T;
  /** WS bridge factory (development mode, connects to core process) */
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
