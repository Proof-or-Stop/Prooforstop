/**
 * Trace diff algorithm (CHK-004)
 */
import type { ProfileNode } from './profiler.js';

export interface DiffNode {
  fn: string;
  file: string;
  line: number;
}

export interface ForkedNode extends DiffNode {
  oldChildren: DiffNode[];
  newChildren: DiffNode[];
}

export interface TraceDiffResult {
  added: DiffNode[];
  removed: DiffNode[];
  forked: ForkedNode[];
}

function nodeKey(node: ProfileNode | DiffNode): string {
  // CHK-006: include line number to disambiguate same-name functions in the same file
  return `${node.fn}@${node.file}:${node.line}`;
}

function toDiffNode(node: ProfileNode): DiffNode {
  return { fn: node.fn, file: node.file, line: node.line };
}

export function diffTraces(oldTree: ProfileNode[], newTree: ProfileNode[]): TraceDiffResult {
  const added: DiffNode[] = [];
  const removed: DiffNode[] = [];
  const forked: ForkedNode[] = [];
  const visited = new Set<string>();
  diffLevel(oldTree || [], newTree || [], added, removed, forked, visited, 0);
  return { added, removed, forked };
}

const MAX_DEPTH = 100;

function diffLevel(
  oldNodes: ProfileNode[], newNodes: ProfileNode[],
  added: DiffNode[], removed: DiffNode[], forked: ForkedNode[],
  visited: Set<string>, depth: number,
): void {
  if (depth > MAX_DEPTH) return;

  const oldMap = new Map<string, ProfileNode>();
  const newMap = new Map<string, ProfileNode>();
  for (const n of oldNodes) { const k = nodeKey(n); if (!oldMap.has(k)) oldMap.set(k, n); }
  for (const n of newNodes) { const k = nodeKey(n); if (!newMap.has(k)) newMap.set(k, n); }

  for (const [key, node] of oldMap) {
    if (!newMap.has(key)) {
      removed.push(toDiffNode(node));
      collectDescendants(node, removed, visited);
    }
  }
  for (const [key, node] of newMap) {
    if (!oldMap.has(key)) {
      added.push(toDiffNode(node));
      collectDescendants(node, added, visited);
    }
  }

  for (const [key, oldNode] of oldMap) {
    const newNode = newMap.get(key);
    if (!newNode) continue;
    if (visited.has(key)) continue;
    visited.add(key);

    const oldChildKeys = new Set((oldNode.children || []).map(nodeKey));
    const newChildKeys = new Set((newNode.children || []).map(nodeKey));
    const childrenDiffer =
      oldChildKeys.size !== newChildKeys.size ||
      [...oldChildKeys].some(k => !newChildKeys.has(k)) ||
      [...newChildKeys].some(k => !oldChildKeys.has(k));

    if (childrenDiffer) {
      forked.push({
        ...toDiffNode(oldNode),
        oldChildren: (oldNode.children || []).map(toDiffNode),
        newChildren: (newNode.children || []).map(toDiffNode),
      });
    }
    diffLevel(oldNode.children || [], newNode.children || [], added, removed, forked, visited, depth + 1);
  }
}

function collectDescendants(node: ProfileNode, target: DiffNode[], visited: Set<string>): void {
  for (const child of (node.children || [])) {
    const key = nodeKey(child);
    if (visited.has(key)) continue;
    visited.add(key);
    target.push(toDiffNode(child));
    collectDescendants(child, target, visited);
  }
}

export function summarizeDiff(diff: TraceDiffResult): string {
  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(`新增 ${diff.added.length} 个节点:`);
    for (const n of diff.added.slice(0, 10)) lines.push(`  + ${n.fn} (${n.file}:${n.line})`);
    if (diff.added.length > 10) lines.push(`  ... 和其他 ${diff.added.length - 10} 个`);
  }
  if (diff.removed.length > 0) {
    lines.push(`消失 ${diff.removed.length} 个节点:`);
    for (const n of diff.removed.slice(0, 10)) lines.push(`  - ${n.fn} (${n.file}:${n.line})`);
    if (diff.removed.length > 10) lines.push(`  ... 和其他 ${diff.removed.length - 10} 个`);
  }
  if (diff.forked.length > 0) {
    lines.push(`分叉 ${diff.forked.length} 个节点:`);
    for (const n of diff.forked.slice(0, 5)) {
      lines.push(`  ⑂ ${n.fn} (${n.file}:${n.line})`);
      lines.push(`    旧: ${n.oldChildren.map(c => c.fn).join(', ')}`);
      lines.push(`    新: ${n.newChildren.map(c => c.fn).join(', ')}`);
    }
  }
  if (lines.length === 0) lines.push('调用链无变化');
  return lines.join('\n');
}
