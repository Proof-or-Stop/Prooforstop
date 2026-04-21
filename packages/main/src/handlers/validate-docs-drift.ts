/**
 * validate-docs-drift — 纯函数：扫 CLAUDE.md 中的 koala 命令引用 vs registry 命令名对齐。
 *
 * 两个方向：
 *   - missing: md 里引用了 `koala <cmd>` 但 registry 中没注册 → 文档承诺了不存在的命令
 *   - stale:   registry 有但 md 里从未提及 → advisory（文档滞后，不阻塞）
 *
 * 只解析 fenced bash 代码块（```bash / ``` 内）里以 koala 开头的行。
 * allowlist 排除已知特例（如 YAGNI 命令）。
 *
 * B-805f CHK-001
 */

export interface DocsDriftResult {
  /** md 里引用了但 registry 没注册的命令 */
  missing: string[];
  /** registry 有但 md 里没提到的命令（advisory） */
  stale: string[];
}

/**
 * 从 markdown 文本的 fenced bash 代码块中提取所有 `koala <cmd>` 命令名。
 *
 * 只匹配 ``` 或 ```bash 围起来的代码块内的行。
 */
export function extractKoalaCommands(mdContent: string): Set<string> {
  const commands = new Set<string>();
  const lines = mdContent.split('\n');
  let inFencedBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 检测 fenced block 开始/结束
    if (trimmed.startsWith('```')) {
      if (inFencedBlock) {
        // closing fence
        inFencedBlock = false;
      } else {
        // opening fence — 只匹配 bash / sh / 无语言标记的代码块
        const lang = trimmed.slice(3).trim().toLowerCase();
        inFencedBlock = lang === '' || lang === 'bash' || lang === 'sh'
          || lang === 'shell';
      }
      continue;
    }

    if (!inFencedBlock) continue;

    // 在 fenced block 内，匹配 koala <cmd> 模式
    // 支持行首可选的 $ / # 前缀和空白
    const match = trimmed.match(/(?:^[$#]\s+)?koala\s+([a-z][a-z0-9_]*)/);
    if (match) {
      commands.add(match[1]);
    }
  }

  return commands;
}

/**
 * 核心纯函数：对比 markdown 中引用的 koala 命令与 registry 实际注册的命令。
 *
 * @param mdContent   - CLAUDE.md 文本内容（可以是多份 md 拼接）
 * @param registryNames - registry.list() 返回的命令名集合
 * @param allowlist   - 不报 missing 的命令白名单（如 YAGNI 命令）
 */
export function checkDocsDrift(
  mdContent: string,
  registryNames: Set<string>,
  allowlist: Set<string> = new Set(),
): DocsDriftResult {
  const mdCommands = extractKoalaCommands(mdContent);

  // 内部命令（以 _ 开头）不纳入 stale 检查
  const INTERNAL_PREFIX = '_';
  // 通用忽略命令（help/status/init 等在 audit-scan 中也忽略）
  const SCAN_IGNORE = new Set(['help', 'init', 'status']);

  const missing: string[] = [];
  const stale: string[] = [];

  // missing: md 里有但 registry 没有
  for (const cmd of mdCommands) {
    if (allowlist.has(cmd)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!registryNames.has(cmd)) {
      missing.push(cmd);
    }
  }

  // stale: registry 有但 md 里没提到
  for (const cmd of registryNames) {
    if (cmd.startsWith(INTERNAL_PREFIX)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!mdCommands.has(cmd)) {
      stale.push(cmd);
    }
  }

  missing.sort();
  stale.sort();

  return { missing, stale };
}

// ── Gate result type (for preflight integration) ──

export interface DocsDriftGateResult {
  provider: 'koala-docs-drift';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  missing: string[];
  stale: string[];
}

/**
 * 已知 YAGNI 命令白名单（与 audit-scan.ts EXPLICIT_YAGNI_COMMANDS 对齐）。
 * CLAUDE.md 里明确说明「不造此 CLI」的命令，扫到不报 missing。
 */
export const DOCS_DRIFT_ALLOWLIST = new Set<string>([
  'audit_config_set',
]);

/**
 * CLI gate 入口：读 CLAUDE.md 文件 + registry 命令名，返回 gate 结果。
 *
 * @param mdContents  - CLAUDE.md 文件内容数组（可以传多份）
 * @param registryNames - registry.list() 的命令名集合
 */
export function runDocsDriftGate(
  mdContents: string[],
  registryNames: Set<string>,
): DocsDriftGateResult {
  if (mdContents.length === 0) {
    return {
      provider: 'koala-docs-drift',
      status: 'skipped',
      summary: '未找到 CLAUDE.md 文件',
      missing: [],
      stale: [],
    };
  }

  const combined = mdContents.join('\n');
  const result = checkDocsDrift(combined, registryNames, DOCS_DRIFT_ALLOWLIST);

  if (result.missing.length > 0) {
    return {
      provider: 'koala-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md 引用了 ${result.missing.length} 个未注册命令: ${result.missing.join(', ')}`,
      missing: result.missing,
      stale: result.stale,
    };
  }

  const staleNote = result.stale.length > 0
    ? ` (${result.stale.length} stale advisory)`
    : '';
  return {
    provider: 'koala-docs-drift',
    status: 'pass',
    summary: `CLAUDE.md 命令引用与 registry 对齐${staleNote}`,
    missing: [],
    stale: result.stale,
  };
}
