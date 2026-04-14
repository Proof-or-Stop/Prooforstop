#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  CLAUDE.md                     Claude Code 指引（注释规范、/koala 入口）
  AGENTS.md                     Codex 指引（session_brief / Story 流程 / Sub agent 约定）
  .claude/skills/koala/       /koala skill 文件
  .claude/agents/             Claude Code sub-agent 定义
  .Codex/agents/              Codex sub-agent 定义
  .Codex/README.md            Codex 入口说明（使用 koala-codex wrapper）
  docs/story/actives/           Story 数据目录
  docs/requirements/            真相源目录
  tests/fixtures/               测试 fixture 目录

初始化后:
  1. 编辑 koala.config.json 调整 scanRoot 等路径
  2. 打开 Claude Code 执行 /koala，或打开 Codex 并让它先跑 koala session_brief
  3. 可选: koala test_auto 跑自动化测试
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
    // B-5010 CHK-005: tmp/ 要整个 ignore，避免 agent 写一次性 helper 脚本被 git add 收进去
    writeFileSync(giPath, 'node_modules\ndist\n__pycache__/\n*.pyc\n.worktrees/\ntmp/*\n!tmp/.gitkeep\n');
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

function syncInstructionFile(targetPath: string, sourcePath: string, label: string, fallbackContent: string) {
  if (!existsSync(targetPath)) {
    if (existsSync(sourcePath)) {
      const content = extractKoalaSection(readFileSync(sourcePath, 'utf-8'));
      writeFileSync(targetPath, content + '\n');
      console.log(`  ✓ ${label} (copied from koala, internal rules stripped)`);
    } else {
      writeFileSync(targetPath, fallbackContent);
      console.log(`  ✓ ${label} (created minimal)`);
    }
    return;
  }

  if (!existsSync(sourcePath)) {
    console.log(`  - ${label} (exists, skip)`);
    return;
  }

  const existing = readFileSync(targetPath, 'utf-8');
  const newSection = extractKoalaSection(readFileSync(sourcePath, 'utf-8'));
  if (existing.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/)) {
    const updated = existing.replace(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/, newSection);
    if (updated !== existing) {
      writeFileSync(targetPath, updated);
      console.log(`  ✓ ${label} (koala section synced)`);
    } else {
      console.log(`  - ${label} (koala section up to date)`);
    }
  } else {
    console.log(`  - ${label} (exists, no koala markers, skip)`);
  }
}

function copyAgentDefinitions(sourceDir: string, targetDir: string, label: string, transform?: (content: string) => string) {
  if (!existsSync(sourceDir)) {
    console.log(`  - ${label} (source missing, skip)`);
    return;
  }
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const entries = ['test-intent.md', 'test-case-reviewer.md'];
  for (const file of entries) {
    const src = join(sourceDir, file);
    const dst = join(targetDir, file);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) {
      console.log(`  - ${label}/${file} (exists, skip)`);
      continue;
    }
    const raw = readFileSync(src, 'utf-8');
    const next = transform ? transform(raw) : raw;
    writeFileSync(dst, next);
    console.log(`  ✓ ${label}/${file}`);
  }
}

// 3. 指引文件（从 koala 项目复制 / 同步 koala:start~koala:end 区间）
console.log('\n[3/5] 配置指引文件...');
const claudeMdPath = join(targetDir, 'CLAUDE.md');
const claudeMdSrc = join(packageRoot, '..', '..', 'CLAUDE.md');
const agentsMdPath = join(targetDir, 'AGENTS.md');
const agentsMdSrc = join(packageRoot, '..', '..', 'AGENTS.md');

function extractKoalaSection(content: string): string {
  // 提取 koala:start ~ koala:end 区间，剥离 koala:internal
  const m = content.match(/<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/);
  if (!m) return content;
  return m[0].replace(/<!--\s*koala:internal:start\s*-->[\s\S]*?<!--\s*koala:internal:end\s*-->\n?/g, '');
}

syncInstructionFile(
  claudeMdPath,
  claudeMdSrc,
  'CLAUDE.md',
  '# CLAUDE.md\n\n执行 `/koala` 即可了解项目全貌并开始工作。\n',
);
syncInstructionFile(
  agentsMdPath,
  agentsMdSrc,
  'AGENTS.md',
  '# AGENTS.md\n\n每次新 session 的第一条命令必须是 `koala session_brief`。\n',
);

// 4. 复制 skill + sub-agent 定义
console.log('\n[4/5] 复制 skill / sub-agent 定义...');
const skillSrc = join(packageRoot, '..', '..', '.claude', 'skills', 'koala');
const skillDst = join(targetDir, '.claude', 'skills', 'koala');
const claudeAgentsSrc = join(packageRoot, '..', '..', '.claude', 'agents');
const claudeAgentsDst = join(targetDir, '.claude', 'agents');
const codexAgentsDst = join(targetDir, '.Codex', 'agents');
const codexReadmeDst = join(targetDir, '.Codex', 'README.md');
const CODEX_README_TEMPLATE = `# Codex + Koala

通用做法：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
\`\`\`

原因：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用写入 \`docs/story/activity.jsonl\`，并标记 \`source=codex\`
- 如果当前项目只有全局 \`koala\`，这是最稳妥的 Codex 入口

如果当前仓库后续增加了本地 wrapper（例如 \`node bin/koala-codex.js\`），再优先切换到本地 wrapper。

建议：

- 新 session 第一条命令跑 \`KOALA_ACTIVITY_SOURCE=codex koala session_brief\`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 如果 \`aux_*\` 不可用，说明当前是 core-only koala：优先找本地 bootstrap 入口；没有的话，用 AGENTS.md 规定的 shell 搜索兜底
`;
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
copyAgentDefinitions(claudeAgentsSrc, claudeAgentsDst, '.claude/agents');
copyAgentDefinitions(claudeAgentsSrc, codexAgentsDst, '.Codex/agents', (content) =>
  content.replace(/Claude Code/g, 'Codex').replace(/\.claude\/agents\//g, '.Codex/agents/'),
);
if (!existsSync(codexReadmeDst)) {
  writeFileSync(codexReadmeDst, CODEX_README_TEMPLATE);
  console.log('  ✓ .Codex/README.md');
} else {
  console.log('  - .Codex/README.md (exists, skip)');
}

// 5. hooks + settings.json
console.log('\n[5/5] 配置 hooks...');
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
  1. Open Claude Code and run /koala, or open Codex and let it read AGENTS.md
  2. First action in a new agent session should be: KOALA_ACTIVITY_SOURCE=codex koala session_brief
  3. If this repo has local wrappers, prefer node bin/koala-codex.js <command>
  4. Optional: edit koala.config.json to adjust scanRoot
  5. Optional: koala test to run flow e2e tests
`);
