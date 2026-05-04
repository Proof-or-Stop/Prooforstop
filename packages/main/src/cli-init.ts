#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  AGENTS_MD_TEMPLATE,
  CODEX_README_TEMPLATE,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
} from './init-assets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..'); // @koala/main 的根目录

// 通过 koala init 调用时 argv[2]='init'，跳过；直接 npx koala-init 时 argv[2] 是目标目录
const rawArg = process.argv[2];
const arg = (rawArg === 'init') ? process.argv[3] : rawArg;

if (arg === '--help' || arg === '-h' || arg === 'help') {
  console.log(`
koala-init — 初始化 koala 开发框架

用法:
  npx koala-init [目标目录]     在指定目录初始化（默认当前目录）
  npx koala-init --help         显示帮助

初始化内容:
  koala.config.json             项目配置（扫描路径、Story 前缀）
  CLAUDE.md                     Claude Code 指引
  src/core/app.ts               应用组装（平台无关）
  src/core/debug.ts             调试入口（devHost）
  src/core/machines/game/bridge.ts  Bridge 接口模板
  src/shells/cli/main.ts        CLI shell 模板
  src/shells/web/               Web shell 目录
  .claude/agents/               koala-implementer 等 subagent 定义
  .Codex/agents/                Codex subagent 定义
  .claude/skills/koala/         /koala skill 文件
  docs/story/actives/           Story 数据目录
  docs/requirements/            真相源目录

初始化后:
  1. 编辑 koala.config.json 调整 scanRoot 等路径
  2. 打开 Claude Code，执行 /koala 开始工作
  3. 可选: koala validate 跑项目验证
`);
  process.exit(0);
}

const targetDir = arg || process.cwd();

console.log(`\nInitializing koala in ${targetDir}\n`);

function write(relPath: string, content: string) {
  const full = join(targetDir, relPath);
  if (existsSync(full)) {
    console.log(`  - ${relPath} (exists, skip)`);
    return false;
  }
  const dir = dirname(full);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
  console.log(`  ✓ ${relPath}`);
  return true;
}

// 1. 目录
console.log('[1/5] 创建目录...');
const dirs = [
  'docs/story/actives',
  'docs/requirements/decisions',
  'docs/requirements/extracted',
  '.claude/skills/koala',
  '.claude/agents',
  '.Codex/agents',
];
for (const d of dirs) {
  const full = join(targetDir, d);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${d}/`);
  }
}

// 1.5 .gitignore（从 koala 项目复制）
const giPath = join(targetDir, '.gitignore');
const giSrc = join(packageRoot, '..', '..', '.gitignore');
if (!existsSync(giPath)) {
  if (existsSync(giSrc)) {
    cpSync(giSrc, giPath);
    console.log('  ✓ .gitignore (copied from koala)');
  } else {
    // B-5010 CHK-005: tmp/ 要整个 ignore，避免 agent 写一次性 helper 脚本被 git add 收进去
    writeFileSync(giPath, 'node_modules\ndist\n__pycache__/\n*.pyc\n.worktrees/\ntmp/*\n!tmp/.gitkeep\n');
    console.log('  ✓ .gitignore (created minimal)');
  }
} else {
  console.log('  - .gitignore (exists, skip)');
}

// 1.6 项目代码目录（src/core + src/shells）
const codeDirs = [
  'src/core/machines/game',
  'src/core/io',
  'src/shells/cli',
  'src/shells/web',
  'tests',
];
for (const d of codeDirs) {
  const full = join(targetDir, d);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${d}/`);
  }
}

// 生成 CLI shell 模板
const cliMainPath = join(targetDir, 'src', 'shells', 'cli', 'main.ts');
if (!existsSync(cliMainPath)) {
  const dir = dirname(cliMainPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cliMainPath, `// CLI shell — 完整版交互入口
// CLI 不是降级版，是完整版。覆盖所有 machine transitions。
// 只通过 bridge 交互，不直接 import fn.ts。

import * as readline from 'readline';
import { createLocalBridge } from '../../core/machines/game/bridge.js';

const bridge = createLocalBridge();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

bridge.onStateChange((state) => {
  // TODO: 根据 state 渲染 CLI 输出
  console.log(JSON.stringify(state, null, 2));
});

function prompt() {
  rl.question('> ', (input) => {
    const trimmed = input.trim();
    if (trimmed === 'quit' || trimmed === 'exit') {
      rl.close();
      return;
    }
    // TODO: 解析用户输入，调用 bridge.sendEvent(event, input)
    bridge.sendEvent(trimmed, {});
    prompt();
  });
}

prompt();
`);
  console.log('  ✓ src/shells/cli/main.ts (CLI shell 模板)');
}

// 生成 bridge 模板
const bridgePath = join(targetDir, 'src', 'core', 'machines', 'game', 'bridge.ts');
if (!existsSync(bridgePath)) {
  const dir = dirname(bridgePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(bridgePath, `// Bridge — 逻辑层与 UI 层的隔离接口
// Shell（CLI/Browser）只 import bridge.ts，不 import fn.ts。

// import type { GameState } from './data.js';
// import { GameMachine } from './machine.js';
// import { parseInput } from './fn.js';

export interface GameBridge {
  sendEvent(event: string, input: any): boolean;
  onStateChange(cb: (state: any) => void): () => void;
  getState(): any;
  getMachineState(): string;
  reset(): void;
}

// LocalBridge：同进程直连
export function createLocalBridge(): GameBridge {
  // TODO: import machine + fn，实现事件分发
  let state: any = {};
  const listeners = new Set<(state: any) => void>();

  function notify() {
    for (const cb of listeners) cb(state);
  }

  return {
    sendEvent(event: string, input: any): boolean {
      // TODO: 从 machine 找 transition，调 guard + action
      console.log(\`[bridge] event: \${event}\`, input);
      return false;
    },
    onStateChange(cb: (state: any) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    getState() { return state; },
    getMachineState() { return 'initial'; },
    reset() {
      state = {};
      notify();
    },
  };
}

// WSBridge：开发时通过 WS 连 core 进程
export function createWSBridge(wsUrl: string): GameBridge {
  const WS = typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket;
  const ws = new WS(wsUrl);
  let state: any = {};
  let machineState = 'unknown';
  const listeners = new Set<(state: any) => void>();

  ws.onmessage = (e: any) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stateChange' || msg.type === 'init') {
        state = msg.state;
        machineState = msg.machineState || machineState;
        for (const cb of listeners) cb(state);
      }
    } catch {}
  };

  return {
    sendEvent(event: string, input: any): boolean {
      ws.send(JSON.stringify({ type: 'event', event, input }));
      return true;
    },
    onStateChange(cb: (state: any) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    getState() { return state; },
    getMachineState() { return machineState; },
    reset() { ws.send(JSON.stringify({ type: 'reset' })); },
  };
}
`);
  console.log('  ✓ src/core/machines/game/bridge.ts (Bridge 模板)');
}

// 生成 app.ts 模板
const appPath = join(targetDir, 'src', 'core', 'app.ts');
if (!existsSync(appPath)) {
  const dir = dirname(appPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(appPath, `// app.ts — 应用组装（平台无关）
// 浏览器和 Node.js 都能运行。不依赖 fs/ws/process。

import { createLocalBridge } from './machines/game/bridge.js';

export async function createApp() {
  const bridge = createLocalBridge();

  // IO 调度示例：
  // bridge.onStateChange((state) => {
  //   if (needsAI(state)) {
  //     getAIMove(state).then(move => bridge.sendEvent('MOVE', move));
  //   }
  // });

  return { bridge };
}
`);
  console.log('  ✓ src/core/app.ts (应用组装模板)');
}

// 生成 debug.ts 模板
const debugPath = join(targetDir, 'src', 'core', 'debug.ts');
if (!existsSync(debugPath)) {
  const dir = dirname(debugPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(debugPath, `// debug.ts — 调试入口
// 框架的 devHost() 负责：WS server + .koala-serve.json + cleanup

import { devHost } from '@koala-agent/core/dev-host';
import { createApp } from './app.js';
// import { GameMachine } from './machines/game/machine.js';

// const app = await devHost(createApp, GameMachine);

// if (process.env.KOALA_SHELL === 'cli') {
//   const { startCliShell } = await import('../shells/cli/main.js');
//   startCliShell(app.bridge);
// }
`);
  console.log('  ✓ src/core/debug.ts (调试入口模板)');
}

// 2. koala.config.json
console.log('\n[2/5] 生成 koala.config.json...');
const koalaConfig: Record<string, unknown> = {
  scanRoot: 'src',
  testsDir: 'tests',
  storyDir: 'docs/story/actives',
  requirementsDir: 'docs/requirements',
  storyPrefix: 'S',
};
// 自动检测项目类型
const isPython = existsSync(join(targetDir, 'requirements.txt'))
  || existsSync(join(targetDir, 'pyproject.toml'))
  || existsSync(join(targetDir, 'setup.py'));

if (isPython) {
  koalaConfig.language = 'python';
  koalaConfig.scanRoot = existsSync(join(targetDir, 'src')) ? 'src' : '.';
  console.log('  ✓ 检测到 Python 项目');
}

// 自动检测浏览器项目
const pkgPath = join(targetDir, 'package.json');
if (existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasHtml = existsSync(join(targetDir, 'index.html')) || existsSync(join(targetDir, 'public', 'index.html'));
    if (hasHtml || deps?.vite || deps?.webpack || deps?.next) {
      const devCmd = deps?.vite ? 'npx vite' : deps?.next ? 'npx next dev' : deps?.webpack ? 'npx webpack serve' : 'npx serve';
      koalaConfig.browser = { devCommand: devCmd };
      console.log(`  ✓ 检测到浏览器项目，browser.devCommand = "${devCmd}"`);
    }
  } catch { /* ignore */ }
}
write('koala.config.json', JSON.stringify(koalaConfig, null, 2) + '\n');

// 3. CLAUDE.md（从 koala 项目复制 / 同步 koala:start~koala:end 区间）
console.log('\n[3/5] 配置 CLAUDE.md...');
const claudeMdPath = join(targetDir, 'CLAUDE.md');
const claudeMdSrc = join(packageRoot, '..', '..', 'CLAUDE.md');

function extractKoalaSection(content: string): string {
  // 提取 koala:start ~ koala:end 区间，剥离 koala:internal
  const m = content.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/);
  if (!m) return content;
  return m[0].replace(/<!--\s*koala:internal:start\s*-->[\s\S]*?<!--\s*koala:internal:end\s*-->\n?/g, '');
}

if (!existsSync(claudeMdPath)) {
  if (existsSync(claudeMdSrc)) {
    const content = extractKoalaSection(readFileSync(claudeMdSrc, 'utf-8'));
    writeFileSync(claudeMdPath, content + '\n');
    console.log('  ✓ CLAUDE.md (copied from koala, internal rules stripped)');
  } else {
    writeFileSync(claudeMdPath, '# CLAUDE.md\n\n执行 `/koala` 即可了解项目全貌并开始工作。\n');
    console.log('  ✓ CLAUDE.md (created minimal)');
  }
} else if (existsSync(claudeMdSrc)) {
  // 已存在：同步 koala:start~koala:end 区间，保留区间外的项目内容
  const existing = readFileSync(claudeMdPath, 'utf-8');
  const newSection = extractKoalaSection(readFileSync(claudeMdSrc, 'utf-8'));
  if (existing.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/)) {
    const updated = existing.replace(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/, newSection);
    if (updated !== existing) {
      writeFileSync(claudeMdPath, updated);
      console.log('  ✓ CLAUDE.md (koala section synced)');
    } else {
      console.log('  - CLAUDE.md (koala section up to date)');
    }
  } else {
    console.log('  - CLAUDE.md (exists, no koala markers, skip)');
  }
} else {
  console.log('  - CLAUDE.md (exists, skip)');
}

const agentsMdPath = join(targetDir, 'AGENTS.md');
if (!existsSync(agentsMdPath)) {
  writeFileSync(agentsMdPath, AGENTS_MD_TEMPLATE);
  console.log('  ✓ AGENTS.md (created)');
} else {
  const existing = readFileSync(agentsMdPath, 'utf-8');
  if (existing.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/)) {
    const updated = existing.replace(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/, AGENTS_MD_TEMPLATE.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/)?.[0] || AGENTS_MD_TEMPLATE);
    if (updated !== existing) {
      writeFileSync(agentsMdPath, updated);
      console.log('  ✓ AGENTS.md (koala section synced)');
    } else {
      console.log('  - AGENTS.md (koala section up to date)');
    }
  } else {
    console.log('  - AGENTS.md (exists, no koala markers, skip)');
  }
}

// 4. 复制 skill
console.log('\n[4/5] 复制 /koala skill...');
const skillSrc = join(packageRoot, '..', '..', '.claude', 'skills', 'koala');
const skillDst = join(targetDir, '.claude', 'skills', 'koala');
if (existsSync(skillSrc)) {
  const skillFile = join(skillSrc, 'skill.md');
  const dstFile = join(skillDst, 'skill.md');
  if (!existsSync(dstFile)) {
    if (!existsSync(skillDst)) mkdirSync(skillDst, { recursive: true });
    cpSync(skillFile, dstFile);
    console.log('  ✓ .claude/skills/koala/skill.md');
  } else {
    console.log('  - .claude/skills/koala/skill.md (exists, skip)');
  }
} else {
  // 从模板生成最小 skill
  write('.claude/skills/koala/skill.md', `# /koala — 项目管理入口

你是项目管理引擎。执行 /koala 了解项目全貌并开始工作。

详细用法参考 @koala/main 文档。
`);
}

// 5. agent 模板 → symlink/copy（发布包内置模板）
console.log('\n[5/6] 同步 agent 模板...');
const agentTemplateDir = [
  join(packageRoot, 'templates', 'agents'),
  join(packageRoot, '..', '..', '.claude', 'agents'),
].find(existsSync);
const agentDstDir = join(targetDir, '.claude', 'agents');
if (agentTemplateDir) {
  for (const file of readdirSync(agentTemplateDir)) {
    if (!file.endsWith('.md')) continue;
    const src = join(agentTemplateDir, file);
    const dst = join(agentDstDir, file);
    const relTarget = relative(agentDstDir, src);

    // 已是正确 symlink → skip
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink() && readlinkSync(dst) === relTarget) {
          console.log(`  - .claude/agents/${file} (symlink ok)`);
          continue;
        }
        // 旧 copy 或错误 symlink → 替换
        unlinkSync(dst);
        console.log(`  ↻ .claude/agents/${file} (replacing copy with symlink)`);
      } catch {
        // lstat 失败（断链等）→ 删除重建
        try { unlinkSync(dst); } catch {}
      }
    }

    symlinkSync(relTarget, dst);
    console.log(`  ✓ .claude/agents/${file} → ${relTarget}`);
  }
} else {
  console.log('  - agent 模板目录不存在, skip');
}

const codexReadmePath = join(targetDir, '.Codex', 'README.md');
if (!existsSync(dirname(codexReadmePath))) mkdirSync(dirname(codexReadmePath), { recursive: true });
writeFileSync(codexReadmePath, CODEX_README_TEMPLATE);
console.log('  ✓ .Codex/README.md');

const codexManifestPath = join(targetDir, '.Codex', 'koala.json');
writeFileSync(codexManifestPath, renderCodexAdapterManifest());
console.log('  ✓ .Codex/koala.json');

if (agentTemplateDir) {
  const codexAgentDir = join(targetDir, '.Codex', 'agents');
  if (!existsSync(codexAgentDir)) mkdirSync(codexAgentDir, { recursive: true });
  const agentPromptFiles = listAgentPromptFiles(agentTemplateDir);
  const agentPromptFileSet = new Set(agentPromptFiles);
  for (const file of listAgentPromptFiles(codexAgentDir)) {
    if (agentPromptFileSet.has(file)) continue;
    unlinkSync(join(codexAgentDir, file));
    console.log(`  - .Codex/agents/${file} (removed stale prompt)`);
  }
  for (const file of agentPromptFiles) {
    const src = join(agentTemplateDir, file);
    const dst = join(codexAgentDir, file);
    const content = renderCodexAgentContent(readFileSync(src, 'utf-8'));
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink()) unlinkSync(dst);
      } catch {
        try { unlinkSync(dst); } catch {}
      }
    }
    writeFileSync(dst, content);
    console.log(`  ✓ .Codex/agents/${file}`);
  }
}

// 6. hooks + settings.json
console.log('\n[6/6] 配置 hooks...');
const hooksDir = join(targetDir, '.claude', 'hooks');
const hookSrc = join(packageRoot, '..', '..', '.claude', 'hooks', 'log-tools.cjs');
const hookDst = join(hooksDir, 'log-tools.cjs');
if (existsSync(hookSrc) && !existsSync(hookDst)) {
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  cpSync(hookSrc, hookDst);
  console.log('  ✓ .claude/hooks/log-tools.cjs');
} else if (existsSync(hookDst)) {
  console.log('  - .claude/hooks/log-tools.cjs (exists, skip)');
}

// 合并 settings.json（不覆盖已有配置）
const settingsPath = join(targetDir, '.claude', 'settings.json');
const koalaHooks = {
  PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$CLAUDE_PROJECT_DIR")/.claude/hooks/log-tools.cjs"' }] }],
  PostToolUseFailure: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$CLAUDE_PROJECT_DIR")/.claude/hooks/log-tools.cjs"' }] }],
};
if (existsSync(settingsPath)) {
  try {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!existing.hooks) existing.hooks = {};
    // 只添加不存在的 hook 事件
    for (const [event, hooks] of Object.entries(koalaHooks)) {
      if (!existing.hooks[event]) {
        existing.hooks[event] = hooks;
        console.log(`  ✓ settings.json: 添加 ${event} hook`);
      } else {
        console.log(`  - settings.json: ${event} hook 已存在, skip`);
      }
    }
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  } catch (e: any) {
    console.log(`  ⚠ settings.json 合并失败: ${e.message}`);
  }
} else {
  writeFileSync(settingsPath, JSON.stringify({ hooks: koalaHooks }, null, 2) + '\n');
  console.log('  ✓ .claude/settings.json (created)');
}

console.log(`
✓ 初始化完成

Next steps:
  1. Open Claude Code, run /koala onboard
  2. Optional: edit koala.config.json to adjust scanRoot
  3. Optional: koala validate to verify project
`);

// NOTE: generateProfileSection / syncProfileSection were previously defined here.
// They now live in claude-md-sync.ts (no side effects) to avoid triggering this
// self-executing init script when imported by other modules (e.g. workflow.ts).
