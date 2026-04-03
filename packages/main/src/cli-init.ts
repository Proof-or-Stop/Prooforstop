#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..'); // @koala/main 的根目录

const arg = process.argv[2];

if (arg === '--help' || arg === '-h' || arg === 'help') {
  console.log(`
koala-init — 初始化 koala 开发框架

用法:
  npx koala-init [目标目录]     在指定目录初始化（默认当前目录）
  npx koala-init --help         显示帮助

初始化内容:
  koala.config.json             项目配置（扫描路径、Story 前缀、flow 测试数据）
  .mcp.json                     MCP 服务配置（合并到已有配置，不覆盖）
  CLAUDE.md                     Claude Code 指引（注释规范、/koala 入口）
  .claude/skills/koala/       /koala skill 文件
  docs/story/actives/           Story 数据目录
  docs/requirements/            真相源目录
  tests/fixtures/               测试 fixture 目录

初始化后:
  1. 编辑 koala.config.json 调整 scanRoot 等路径
  2. 打开 Claude Code，执行 /koala 开始工作
  3. 可选: koala test 跑 flow 端到端测试
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
  'tests/fixtures',
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
    writeFileSync(giPath, 'node_modules\ndist\n__pycache__/\n*.pyc\n.claude/worktrees/\n');
    console.log('  ✓ .gitignore (created minimal)');
  }
} else {
  console.log('  - .gitignore (exists, skip)');
}

// 2. koala.config.json
console.log('\n[2/5] 生成 koala.config.json...');
const koalaConfig: Record<string, unknown> = {
  scanRoot: 'src',
  testsDir: 'tests',
  fixturesDir: 'tests/fixtures',
  storyDir: 'docs/story/actives',
  requirementsDir: 'docs/requirements',
  storyPrefix: 'S',
  flows: {
    defaults: {},
    patterns: [],
  },
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

// 3. .mcp.json（合并，不覆盖）
console.log('\n[3/5] 配置 .mcp.json...');
const mcpPath = join(targetDir, '.mcp.json');

// 检测 koala core 的 server.js 路径（monorepo 子项目用相对路径）
let koalaMcp: Record<string, unknown>;
const serverCandidates = [
  join(targetDir, 'node_modules', '@koala-agent', 'core', 'dist', 'mcp', 'server.js'),
  join(targetDir, '..', 'main', 'dist', 'mcp', 'server.js'),
  join(targetDir, '..', '..', 'packages', 'main', 'dist', 'mcp', 'server.js'),
];
const foundServer = serverCandidates.find(p => existsSync(p));
if (foundServer) {
  // 用相对路径指向 koala core server
  const { relative: relPath } = require('path');
  const rel = relPath(targetDir, foundServer).replace(/\\/g, '/');
  koalaMcp = { command: 'node', args: [rel], cwd: '.' };
  console.log(`  ✓ 检测到 koala core: ${rel}`);
} else {
  koalaMcp = { command: 'koala', args: ['serve'] };
}
if (existsSync(mcpPath)) {
  try {
    const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    if (existing.mcpServers?.['koala-mcp']) {
      console.log('  - .mcp.json koala-mcp (exists, skip)');
    } else {
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers['koala-mcp'] = koalaMcp;
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
      console.log('  ✓ .mcp.json (merged koala into existing)');
    }
  } catch {
    console.log('  ⚠ .mcp.json exists but cannot parse, skip');
  }
} else {
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'koala-mcp': koalaMcp } }, null, 2) + '\n');
  console.log('  ✓ .mcp.json (created)');
}

// 4. CLAUDE.md（从 koala 项目复制）
console.log('\n[4/5] 配置 CLAUDE.md...');
const claudeMdPath = join(targetDir, 'CLAUDE.md');
const claudeMdSrc = join(packageRoot, '..', '..', 'CLAUDE.md');
if (!existsSync(claudeMdPath)) {
  if (existsSync(claudeMdSrc)) {
    cpSync(claudeMdSrc, claudeMdPath);
    console.log('  ✓ CLAUDE.md (copied from koala)');
  } else {
    writeFileSync(claudeMdPath, '# CLAUDE.md\n\n执行 `/koala` 即可了解项目全貌并开始工作。\n');
    console.log('  ✓ CLAUDE.md (created minimal)');
  }
} else {
  console.log('  - CLAUDE.md (exists, skip)');
}

// 5. 复制 skill
console.log('\n[5/5] 复制 /koala skill...');
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
  3. Optional: koala test to run flow e2e tests
`);
