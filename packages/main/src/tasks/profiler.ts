/**
 * V8 Profiler wrapper using node:inspector
 * CHK-001: CLI-side profiling for test_auto cases
 */
import { Session } from 'node:inspector/promises';

export interface ProfileNode {
  fn: string;
  file: string;
  line: number;
  children: ProfileNode[];
}

/** Start a V8 CPU profiler session. Returns a handle to stop and collect results. */
export async function startProfiler(): Promise<{ stop: () => Promise<ProfileNode[]> }> {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.start');

  return {
    async stop(): Promise<ProfileNode[]> {
      const { profile } = await session.post('Profiler.stop') as any;
      await session.post('Profiler.disable');
      session.disconnect();
      return extractCallTree(profile);
    },
  };
}

/**
 * CHK-004: Fixture-level profiler session — one inspector connection per fixture file.
 * Call startCase/stopCase for each case to get per-case traces without session overhead.
 */
export class FixtureProfilerSession {
  private session: Session | null = null;

  async open(): Promise<void> {
    this.session = new Session();
    this.session.connect();
    await this.session.post('Profiler.enable');
  }

  async startCase(): Promise<void> {
    if (!this.session) throw new Error('Session not opened');
    await this.session.post('Profiler.start');
  }

  async stopCase(): Promise<ProfileNode[]> {
    if (!this.session) throw new Error('Session not opened');
    const { profile } = await this.session.post('Profiler.stop') as any;
    return extractCallTree(profile);
  }

  async close(): Promise<void> {
    if (this.session) {
      try { await this.session.post('Profiler.disable'); } catch {}
      this.session.disconnect();
      this.session = null;
    }
  }
}

/** Extract a simplified call tree from V8 CPU profile, filtering to project-internal functions */
function extractCallTree(profile: any): ProfileNode[] {
  const nodes: any[] = profile.nodes || [];
  if (nodes.length === 0) return [];

  const nodeMap = new Map<number, any>();
  for (const n of nodes) nodeMap.set(n.id, n);

  /** Collect children from raw node, flattening arrays from filtered nodes */
  function collectChildren(raw: any): ProfileNode[] {
    const children: ProfileNode[] = [];
    for (const childId of (raw.children || [])) {
      const child = nodeMap.get(childId);
      if (child) {
        const result = toProfileNode(child);
        if (result) {
          if (Array.isArray(result)) children.push(...result);
          else children.push(result);
        }
      }
    }
    return children;
  }

  function toProfileNode(raw: any): ProfileNode | ProfileNode[] | null {
    const cf = raw.callFrame;
    if (!cf) return null;

    const url = cf.url || '';
    if (!url || url.startsWith('node:') || url.includes('node_modules')) {
      // CHK-005: promote children directly instead of wrapping in (anonymous)@ virtual node
      const childNodes = collectChildren(raw);
      if (childNodes.length === 0) return null;
      if (childNodes.length === 1) return childNodes[0];
      return childNodes; // multiple children promoted as array
    }

    return {
      fn: cf.functionName || '(anonymous)',
      file: normalizeUrl(url),
      line: cf.lineNumber ?? 0,
      children: collectChildren(raw),
    };
  }

  const roots: ProfileNode[] = [];
  const root = nodeMap.get(nodes[0]?.id);
  if (root) {
    const children = collectChildren(root);
    roots.push(...children);
  }
  if (roots.length === 0 && root) {
    const cn = toProfileNode(root);
    if (cn) {
      if (Array.isArray(cn)) roots.push(...cn);
      else roots.push(cn);
    }
  }

  return roots;
}

function normalizeUrl(url: string): string {
  let path = url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  path = path.replace(/\\/g, '/');
  path = path.replace(/^[A-Za-z]:/, '');
  return path;
}

/** CDP profiler wrapper for browser-side profiling (CHK-002) */
export async function startCdpProfiler(cdpSend: (method: string, params?: any) => Promise<any>): Promise<{ stop: () => Promise<ProfileNode[]> }> {
  await cdpSend('Profiler.enable');
  await cdpSend('Profiler.start');

  return {
    async stop(): Promise<ProfileNode[]> {
      const result = await cdpSend('Profiler.stop');
      await cdpSend('Profiler.disable');
      return extractCallTree(result.profile);
    },
  };
}
