/**
 * aux_trace command (formerly arch_trace, CHK-006)
 */
import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { loadConfig } from '../../../main/dist/core/config.js';
import { extname, join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { scanAllTraces } from '../../../main/dist/tasks/trace-store.js';
import type { ProfileNode } from '../../../main/dist/tasks/profiler.js';
import { CODE_EXTENSIONS } from '../../../main/dist/tasks/extract.js';

interface LogicLine {
  entry: string;
  chain: string[];
  caseNames: string[];
  commits: string[];
}

interface ImpactEdge {
  from: string;
  to: string;
  weight: number;
  /** 该边是回边（形成循环） */
  isCycle?: boolean;
}

interface ArchTraceResult {
  logicLines: LogicLine[];
  impactGraph: ImpactEdge[];
  blindZones: string[];
  cycles: string[][]; // 检测到的循环路径
}

export function createAuxTraceHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async aux_trace(args?: { format?: 'json' | 'mermaid' }): Promise<string> {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);
      const format = args?.format || 'json';

      progress('aux_trace: scanning all traces...');
      const snapshots = scanAllTraces(root);
      if (snapshots.length === 0) return JSON.stringify({ hint: '→ 无 trace 数据，请先运行 test_auto 积累 trace 快照' });

      const logicLines: LogicLine[] = [];
      const edgeCounter = new Map<string, { weight: number; isCycle: boolean }>();
      const allFunctions = new Set<string>();

      for (const snap of snapshots) {
        const { chains, cycleEdges } = extractGraph(snap.trace);
        for (const chain of chains) {
          if (chain.length === 0) continue;
          const entry = chain[0];
          const chainStrs = chain.map(n => `${n.fn}@${n.file}`);
          for (const str of chainStrs) allFunctions.add(str);
          for (let i = 0; i < chainStrs.length - 1; i++) {
            const ek = `${chainStrs[i]}→${chainStrs[i + 1]}`;
            const existing = edgeCounter.get(ek);
            if (existing) { existing.weight++; }
            else { edgeCounter.set(ek, { weight: 1, isCycle: false }); }
          }
          logicLines.push({
            entry: `${entry.fn}@${entry.file}`,
            chain: chainStrs,
            caseNames: [snap.caseName],
            commits: [snap.commit],
          });
        }
        // 标记回边
        for (const ce of cycleEdges) {
          const ek = `${ce.from}→${ce.to}`;
          const existing = edgeCounter.get(ek);
          if (existing) { existing.isCycle = true; }
          else { edgeCounter.set(ek, { weight: 1, isCycle: true }); }
        }
      }

      const mergedLines = mergeLogicLines(logicLines);

      const impactGraph: ImpactEdge[] = [];
      for (const [ek, v] of edgeCounter) {
        const [from, to] = ek.split('→');
        impactGraph.push({ from, to, weight: v.weight, ...(v.isCycle ? { isCycle: true } : {}) });
      }
      impactGraph.sort((a, b) => b.weight - a.weight);

      // 收集所有检测到的循环路径
      const cycles = detectCycles(impactGraph);

      const blindZones = detectBlindZones(root, config, allFunctions);
      const result: ArchTraceResult = { logicLines: mergedLines, impactGraph, blindZones, cycles };

      if (format === 'mermaid') return generateMermaid(result);
      progress(`aux_trace: ${mergedLines.length} logic lines, ${impactGraph.length} edges, ${blindZones.length} blind zones, ${cycles.length} cycles`);
      return JSON.stringify(result, null, 2);
    },
  };
}

/** 从调用树提取链 + 检测环（图遍历，遇到回边标记而非截断） */
function extractGraph(nodes: ProfileNode[]): {
  chains: Array<Array<{ fn: string; file: string }>>;
  cycleEdges: Array<{ from: string; to: string }>;
} {
  const chains: Array<Array<{ fn: string; file: string }>> = [];
  const cycleEdges: Array<{ from: string; to: string }> = [];

  function walk(node: ProfileNode, path: Array<{ fn: string; file: string }>, visited: Set<string>) {
    const key = `${node.fn}@${node.file}`;
    const current = [...path, { fn: node.fn, file: node.file }];

    if (!node.children || node.children.length === 0) {
      chains.push(current);
      return;
    }

    for (const child of node.children) {
      const childKey = `${child.fn}@${child.file}`;
      if (visited.has(childKey)) {
        // 回边：形成循环，标记但不递归
        cycleEdges.push({ from: key, to: childKey });
        chains.push(current); // 到此为止记录链
        continue;
      }
      visited.add(childKey);
      walk(child, current, visited);
      visited.delete(childKey);
    }
  }

  for (const r of nodes) {
    const rootKey = `${r.fn}@${r.file}`;
    const visited = new Set<string>([rootKey]);
    walk(r, [], visited);
  }
  return { chains, cycleEdges };
}

/** 从 impactGraph 中找出所有循环路径 */
function detectCycles(edges: ImpactEdge[]): string[][] {
  // 建邻接表
  const adj = new Map<string, string[]>();
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.from);
    allNodes.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const cycles: string[][] = [];
  const globalVisited = new Set<string>();

  for (const start of allNodes) {
    if (globalVisited.has(start)) continue;
    const stack: string[] = [];
    const inStack = new Set<string>();

    function dfs(node: string): void {
      if (cycles.length >= 10) return; // 限制输出
      globalVisited.add(node);
      stack.push(node);
      inStack.add(node);

      for (const next of (adj.get(node) || [])) {
        if (inStack.has(next)) {
          // 找到循环：从 next 到当前 stack 末尾
          const cycleStart = stack.indexOf(next);
          if (cycleStart >= 0) {
            cycles.push([...stack.slice(cycleStart), next]);
          }
        } else if (!globalVisited.has(next)) {
          dfs(next);
        }
      }

      stack.pop();
      inStack.delete(node);
    }

    dfs(start);
  }

  return cycles;
}

function mergeLogicLines(lines: LogicLine[]): LogicLine[] {
  const map = new Map<string, LogicLine>();
  for (const line of lines) {
    const key = line.chain.join('|');
    const existing = map.get(key);
    if (existing) {
      for (const n of line.caseNames) if (!existing.caseNames.includes(n)) existing.caseNames.push(n);
      for (const c of line.commits) if (!existing.commits.includes(c)) existing.commits.push(c);
    } else {
      map.set(key, { ...line, commits: [...line.commits] });
    }
  }
  return [...map.values()];
}

function detectBlindZones(root: string, config: any, tracedFunctions: Set<string>): string[] {
  const scanRoot = join(root, config.scanRoot || '');
  const blindZones: string[] = [];
  function scan(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        scan(join(dir, entry.name));
      } else if (CODE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        const filePath = join(dir, entry.name);
        const relPath = filePath.replace(scanRoot, '').replace(/\\/g, '/').replace(/^\//, '');
        try {
          const src = readFileSync(filePath, 'utf-8');
          const exportedFns: string[] = [];
          // CHK-007: detect export function, export const arrow, and class methods
          // 1. export [async] function name
          const fnRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
          let match;
          while ((match = fnRegex.exec(src)) !== null) exportedFns.push(match[1]);
          // 2. export const name = (...) => / export const name = function
          const arrowRegex = /export\s+const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::\s*\w[^=]*?)?\s*=>|function\b)/g;
          while ((match = arrowRegex.exec(src)) !== null) exportedFns.push(match[1]);
          const pythonRegex = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
          while ((match = pythonRegex.exec(src)) !== null) exportedFns.push(match[1]);
          const goRegex = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm;
          while ((match = goRegex.exec(src)) !== null) exportedFns.push(match[1]);
          const swiftRegex = /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|static\s+|class\s+|mutating\s+)*func\s+(\w+)\s*\(/gm;
          while ((match = swiftRegex.exec(src)) !== null) exportedFns.push(match[1]);
          const javaLikeRegex = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|override\s+|virtual\s+|inline\s+|constexpr\s+)*[\w:<>,~*&\s]+\s+(\w+)\s*\(/gm;
          while ((match = javaLikeRegex.exec(src)) !== null) {
            const name = match[1];
            if (!['if', 'for', 'while', 'switch', 'return', 'catch'].includes(name)) exportedFns.push(name);
          }
          // 3. class methods in exported classes: export class Foo { methodName(
          const classRegex = /export\s+class\s+(\w+)/g;
          const methodRegex = /(?:^|\s|;|\{)(?:async\s+)?(\w+)\s*\(/gm;
          while ((match = classRegex.exec(src)) !== null) {
            const className = match[1];
            // Find class body start
            const classStart = match.index + match[0].length;
            const braceStart = src.indexOf('{', classStart);
            if (braceStart < 0) continue;
            // Simple brace matching for class body
            let depth = 1, pos = braceStart + 1;
            while (pos < src.length && depth > 0) {
              if (src[pos] === '{') depth++;
              else if (src[pos] === '}') depth--;
              pos++;
            }
            const classBody = src.slice(braceStart, pos);
            let mMatch;
            while ((mMatch = methodRegex.exec(classBody)) !== null) {
              const methodName = mMatch[1];
              if (methodName !== 'constructor' && !methodName.startsWith('_')) {
                exportedFns.push(`${className}.${methodName}`);
              }
            }
          }
          for (const fnName of exportedFns) {
            const baseName = fnName.includes('.') ? fnName.split('.')[0] : fnName;
            const isTraced = [...tracedFunctions].some(tf => tf.includes(baseName) && tf.includes(relPath.slice(0, -extname(relPath).length)));
            if (!isTraced) blindZones.push(`${fnName}@${relPath}`);
          }
        } catch {}
      }
    }
  }
  scan(scanRoot);
  return blindZones;
}

function generateMermaid(result: ArchTraceResult): string {
  const lines: string[] = ['flowchart TD'];
  const nodeIds = new Map<string, string>();
  let nc = 0;
  function getId(name: string) { if (!nodeIds.has(name)) nodeIds.set(name, `N${nc++}`); return nodeIds.get(name)!; }
  for (const edge of result.impactGraph.slice(0, 50)) {
    const fi = getId(edge.from); const ti = getId(edge.to);
    const style = edge.isCycle ? ' -.->|cycle|' : ` -->|${edge.weight}|`;
    lines.push(`  ${fi}["${edge.from.split('@')[0]}"]${style} ${ti}["${edge.to.split('@')[0]}"]`);
  }
  if (result.blindZones.length > 0) {
    lines.push('  classDef blind fill:#f96,stroke:#333');
    for (const bz of result.blindZones.slice(0, 20)) {
      lines.push(`  ${getId(bz)}["${bz.split('@')[0]}"]:::blind`);
    }
  }
  if (result.cycles.length > 0) {
    lines.push(`  %% 检测到 ${result.cycles.length} 个循环依赖`);
  }
  return lines.join('\n');
}
