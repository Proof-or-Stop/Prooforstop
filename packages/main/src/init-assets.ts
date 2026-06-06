import { readdirSync } from 'fs';
import {
  promptRegistryManifest,
  renderCodexPromptContent,
  type PromptRegistryManifest,
} from './core/prompt-registry.js';

export const SUPPORTED_INIT_PROFILES = ['codex', 'claude', 'all', 'core'] as const;
export type InitProfile = typeof SUPPORTED_INIT_PROFILES[number];
export const SUPPORTED_INIT_ASSET_MODES = ['full', 'thin'] as const;
export type InitAssetMode = typeof SUPPORTED_INIT_ASSET_MODES[number];
export type CodexPromptMode = 'legacy-mirror' | 'registry';

export function listAgentPromptFiles(agentDir: string): string[] {
  return readdirSync(agentDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

<!-- koala:start -->
## Lattice

- \`LATTICE.md\` is the host-neutral Lattice guide; this file keeps only Codex / AGENTS additions.
- At the start of a new session, or when resuming interrupted work, run \`lattice codex session_brief\`.
- Before acting, run \`lattice codex aux_doc_list\` to inspect relevant docs; if the current global core-only environment lacks aux commands, fall back to the local bootstrap or shell search.
- Prefer \`lattice\` for Story / checklist / fixture / bug operations, and use \`lattice codex\` when the command should be tagged as Codex activity. Do not edit story/fixture JSON directly; \`koala\` is only a legacy alias.
- Codex subagent prompts use the Lattice adapter: full asset mode materializes \`.Codex/agents\`, while thin asset mode resolves prompts from the package registry. Claude Code-only assets are generated only when the Claude profile is enabled.
- After changing the Codex adapter, \`.Codex\`, or \`bin/lattice-codex.js\`, run \`lattice codex verify\` so REVIEW/DONE gates can consume hard evidence.
- For Codex adapter diagnostics, run \`lattice codex doctor\`.
- Run \`lattice check\` to check Lattice managed asset/template drift; after review, use \`lattice check --apply\` or \`lattice check --upgrade\` to sync safe items.

<!-- koala:end -->
`;

export const LATTICE_MD_TEMPLATE = `# LATTICE.md

<!-- koala:start -->
## Lattice

\`LATTICE.md\` is the canonical, host-neutral Lattice guide. New init profiles create or sync this file.

- At the start of a new session, or when resuming interrupted work, run \`lattice session_brief\`.
- Before acting, run \`lattice aux_doc_list\` to inspect relevant docs; if the current global core-only environment lacks aux commands, fall back to the local bootstrap or shell search.
- Prefer \`lattice\` for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly; \`koala\` remains a legacy alias.
- The default global entrypoint is \`lattice\`; if the profile generated a Codex adapter, use \`lattice codex\` for Codex-tagged operations.
- Codex-specific notes live in \`AGENTS.md\` and \`.Codex/README.md\`; Claude-specific notes live in \`CLAUDE.md\` and \`.claude/\`.
- After changing Lattice adapter assets, run the corresponding verification: project validation uses \`lattice validate\`, and the Codex adapter additionally uses \`lattice codex verify\`.
- \`lattice check\` checks Lattice managed assets against the hardcoded registry. \`lattice check --apply\` / \`lattice check --upgrade\` sync only MISSING/STALE_SAFE items and do not overwrite CASE_MISMATCH, local edits, or incompatible files.
- Legacy projects may still expose \`KOALA.md\`, \`bin/koala.js\`, \`bin/koala-codex.js\`, and \`.Codex/koala.json\` as compatibility assets. New init no longer generates those files by default.

<!-- koala:end -->
`;

export const KOALA_MD_TEMPLATE = `# KOALA.md

<!-- koala:start -->
## Koala

\`KOALA.md\` is the legacy canonical, host-neutral Koala guide. Existing legacy init profiles may still create or sync this file.

- At the start of a new session, or when resuming interrupted work, run \`koala session_brief\`.
- Before acting, run \`koala aux_doc_list\` to inspect relevant docs; if the current global core-only environment lacks aux commands, fall back to the local bootstrap or shell search.
- Prefer the \`koala\` CLI for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly.
- The default local entrypoint is \`node bin/koala.js\`; if the profile generated a Codex adapter, also use \`node bin/koala-codex.js\`.
- Codex-specific notes live in \`AGENTS.md\` and \`.Codex/README.md\`; Claude-specific notes live in \`CLAUDE.md\` and \`.claude/\`.
- After changing Koala adapter assets, run the corresponding verification: project validation uses \`koala validate\`, and the Codex adapter additionally uses \`node bin/koala-codex.js verify_codex\`.
- \`koala check\` checks Koala managed assets against the hardcoded registry. \`koala check --apply\` / \`koala check --upgrade\` sync only MISSING/STALE_SAFE items and do not overwrite CASE_MISMATCH, local edits, or incompatible files.

<!-- koala:end -->
`;

export const CLAUDE_MD_TEMPLATE = `# CLAUDE.md

<!-- koala:start -->
## Lattice For Claude Code

- \`LATTICE.md\` is the canonical, host-neutral Lattice guide; Story lifecycle facts and shared rules derive from it.
- Claude Code entrypoints should first run \`lattice session_brief\`; daily operations should use global \`lattice\`. \`koala\` is only a legacy alias.
- Claude Code subagents live in \`.claude/agents\`.
- Claude Code hooks live in \`.claude/hooks\`, and Claude settings live in \`.claude/settings.json\`.
- The Claude Code \`/koala\` skill lives in \`.claude/skills/koala\`.
- When the repository also enables the Codex profile, Codex assets live separately under \`.Codex/\`; do not treat this file as a shared truth source for both hosts.
- Run \`lattice check\` to check Lattice managed asset/template drift; after review, use \`lattice check --apply\` or \`lattice check --upgrade\` to sync safe items.

<!-- koala:end -->
`;

export interface CodexAdapterManifest {
  adapterOwner: string;
  adapterKind: 'codex';
  activitySource: 'codex';
  recommendedEntrypoints: readonly {
    name: string;
    command: string;
    useWhen: string;
  }[];
  sessionEnv: {
    source: string;
    session: string;
    recordReadOnly: string;
    sessionCandidates: readonly string[];
  };
  excludedRuntimeAssets: readonly string[];
  notes: readonly string[];
}

export const CODEX_ADAPTER_MANIFEST: CodexAdapterManifest = {
  adapterOwner: 'koala',
  adapterKind: 'codex',
  activitySource: 'codex',
  recommendedEntrypoints: [
    {
      name: 'local-wrapper',
      command: 'node bin/koala-codex.js',
      useWhen: 'This repository includes the Koala bootstrap wrapper.',
    },
    {
      name: 'global-fallback',
      command: 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala',
      useWhen: 'Only the global koala CLI is available for read-only heartbeats; do not use it as current-worktree gate/status evidence when a local wrapper or core CLI exists.',
    },
  ],
  sessionEnv: {
    source: 'KOALA_ACTIVITY_SOURCE',
    session: 'KOALA_ACTIVITY_SESSION',
    recordReadOnly: 'KOALA_ACTIVITY_RECORD_READONLY',
    sessionCandidates: [
      'CODEX_SESSION_ID',
      'OPENAI_SESSION_ID',
      'TERM_SESSION_ID',
    ],
  },
  excludedRuntimeAssets: [
    '.Codex/hooks',
    '.Codex/settings.json',
  ],
  notes: [
    'This file is read by Koala tooling, not by the Codex runtime.',
    'Codex agent prompts live in .Codex/agents and are generated from .claude/agents.',
    'Claude Code hooks, settings, and skills remain under .claude only.',
    'Run node bin/koala-codex.js verify_codex after changing Codex adapter assets; it records codex_adapter_verification evidence for gates.',
  ],
} as const;

export const LATTICE_CODEX_ADAPTER_MANIFEST: CodexAdapterManifest = {
  ...CODEX_ADAPTER_MANIFEST,
  adapterOwner: 'lattice',
  recommendedEntrypoints: [
    {
      name: 'global-codex',
      command: 'lattice codex',
      useWhen: 'Use the global Lattice primary CLI for Codex-tagged operations after installing or linking the current package.',
    },
    {
      name: 'local-wrapper',
      command: 'node bin/lattice-codex.js',
      useWhen: 'Use only when you need to prove the repository-local wrapper path or when the global CLI is unavailable.',
    },
    {
      name: 'global-fallback',
      command: 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback lattice',
      useWhen: 'Only the global lattice CLI is available for read-only heartbeats; do not use it as current-worktree gate/status evidence when a local wrapper or core CLI exists.',
    },
  ],
  notes: [
    'This file is read by Lattice tooling, not by the Codex runtime.',
    'Codex agent prompts live in .Codex/agents and are generated from .claude/agents in full asset mode.',
    'Claude Code hooks, settings, and skills remain under .claude only.',
    'Run lattice codex verify after changing Codex adapter assets; it records codex_adapter_verification evidence for gates.',
    'Legacy Koala projects may still use .Codex/koala.json and bin/koala-codex.js as compatibility assets.',
  ],
} as const;

export interface RenderCodexAdapterManifestOptions {
  promptMode?: CodexPromptMode;
  promptRegistry?: PromptRegistryManifest;
}

export function renderCodexAdapterManifest(options: RenderCodexAdapterManifestOptions = {}): string {
  if (options.promptMode !== 'registry') {
    return `${JSON.stringify(CODEX_ADAPTER_MANIFEST, null, 2)}\n`;
  }

  return `${JSON.stringify({
    ...CODEX_ADAPTER_MANIFEST,
    promptMode: 'registry',
    promptRegistry: options.promptRegistry ?? promptRegistryManifest(),
    notes: [
      ...CODEX_ADAPTER_MANIFEST.notes,
      'Thin asset mode uses the package prompt registry instead of materializing .Codex/agents prompt copies.',
    ],
  }, null, 2)}\n`;
}

export function renderLatticeCodexAdapterManifest(options: RenderCodexAdapterManifestOptions = {}): string {
  if (options.promptMode !== 'registry') {
    return `${JSON.stringify(LATTICE_CODEX_ADAPTER_MANIFEST, null, 2)}\n`;
  }

  return `${JSON.stringify({
    ...LATTICE_CODEX_ADAPTER_MANIFEST,
    promptMode: 'registry',
    promptRegistry: options.promptRegistry ?? promptRegistryManifest(),
    notes: [
      ...LATTICE_CODEX_ADAPTER_MANIFEST.notes,
      'Thin asset mode uses the package prompt registry instead of materializing .Codex/agents prompt copies.',
    ],
  }, null, 2)}\n`;
}

const CODEX_README_LEGACY_TEMPLATE = `# Codex + Koala

Preferred usage:

\`\`\`bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
\`\`\`

Why:

- \`node bin/koala-codex.js\` is the preferred in-repo Codex entrypoint and loads the local bootstrap (main + utils).
- The wrapper writes \`.koala/activity.jsonl\` and marks entries with \`source=codex\`.
- The wrapper enables activity heartbeat logging for read-only recovery commands such as \`session_brief\`.

Use the global fallback only when the current project has no local wrapper:

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala session_brief
\`\`\`

Fallback notes:

- \`KOALA_ACTIVITY_SOURCE=codex\` marks this invocation with \`source=codex\`.
- \`KOALA_ACTIVITY_RECORD_READONLY=1\` records heartbeat entries for read-only entrypoints such as \`session_brief\`.
- \`KOALA_CODEX_ENTRYPOINT=global-fallback\` prevents local wrapper subprocesses from mislabeling the global fallback as \`local-wrapper\`.
- The global \`koala\` may be core-only, so \`aux_*\` commands may be unavailable.
- The global \`koala\` may lag behind the current worktree; when a local wrapper or \`node packages/main/dist/cli.js\` is available, do not treat fallback \`status\` / \`next\` / \`validate\` output as gate evidence.
- \`.Codex/agents\` is generated from the complete \`.claude/agents\` prompt set; Claude hooks/settings/skills remain exclusive to \`.claude\`.
- \`.Codex/koala.json\` is the Codex adapter manifest read by Koala itself. It describes the recommended entrypoint, session environment variables, and runtime assets that are intentionally not generated.

Recommendations:

- Run \`node bin/koala-codex.js session_brief\` as the first command in a new session.
- Keep day-to-day story/checklist/fixture/bug operations on the same entrypoint whenever possible.
- When developing the Koala repository itself and the full wrapper is temporarily unavailable, use \`node packages/main/dist/cli.js <command>\` for current-worktree status/gate/validate decisions.
- After changing Codex adapter assets, run \`node bin/koala-codex.js verify_codex\` (or \`node bin/koala.js verify_codex\`). It verifies the manifest, agent mirror, wrapper heartbeat, global fallback heartbeat, and runtime exclusions, then writes process-event evidence consumable by gates.
- Run \`koala check\` to inspect Koala managed asset/template drift; after review, use \`koala check --apply\` or \`koala check --upgrade\` to sync safe items.
- Initialization scripts can run \`npx koala-init --verify-codex\` for same-source asset verification.
- When diagnosing the Codex adapter, run \`node bin/koala-codex.js doctor\` to inspect shared checks, health, and worktree state together.
- If \`aux_*\` is unavailable, the current global koala is core-only. Prefer a local bootstrap entrypoint; if none exists, fall back to shell search as required by AGENTS.md.

Boundaries:

- Do not create \`.Codex/hooks\`; the Codex runtime does not execute Claude Code hooks.
- Do not create \`.Codex/settings.json\`; the Codex runtime does not read Claude Code settings.
- To observe Codex activity, use the wrapper recorded in \`.Codex/koala.json\` or a fallback invocation with \`KOALA_ACTIVITY_RECORD_READONLY=1\`.
`;

const CODEX_README_THIN_APPENDIX = `
## Thin Asset Mode

This repository uses registry-backed Codex prompts:

- \`.Codex/koala.json\` records \`promptMode=registry\` and the package prompt registry hash.
- \`.Codex/agents\` prompt copies are not required for Koala adapter verification in this mode.
- Legacy full-mode repositories may still materialize \`.Codex/agents\`; both modes remain supported.
- This is adapter hygiene only. It does not replace validation evidence, receipts, or production authority.
`;

export type CodexAdapterBrand = 'lattice' | 'koala';

const CODEX_README_LATTICE_TEMPLATE = `# Codex + Lattice

Preferred usage:

\`\`\`bash
lattice codex session_brief
lattice codex aux_doc_list --format=json
\`\`\`

Why:

- \`lattice codex\` is the primary global Lattice namespace for Codex-tagged operations.
- It dispatches normal Lattice commands after marking activity with \`source=codex\`.
- It enables activity heartbeat logging for read-only recovery commands such as \`session_brief\`.

Local wrapper fallback:

\`\`\`bash
node bin/lattice-codex.js session_brief
\`\`\`

Fallback notes:

- The local wrapper loads the repository bootstrap and marks activity with \`source=codex\`.
- Use it only when the global \`lattice\` command is unavailable, or when you need explicit current-wrapper heartbeat evidence.
- If the global command is not linked to this checkout, verification reports the global heartbeat as advisory rather than hard current-worktree evidence.
- \`.Codex/agents\` is generated from the complete \`.claude/agents\` prompt set; Claude hooks/settings/skills remain exclusive to \`.claude\`.
- \`.Codex/lattice.json\` is the Codex adapter manifest read by Lattice itself. It describes the recommended entrypoint, session environment variables, and runtime assets that are intentionally not generated.

Recommendations:

- Run \`lattice codex session_brief\` as the first command in a new session.
- Keep day-to-day story/checklist/fixture/bug operations on the same entrypoint whenever possible.
- When developing the Lattice/Koala repository itself and the full wrapper is temporarily unavailable, use \`node packages/main/dist/cli.js <command>\` for current-worktree status/gate/validate decisions.
- After changing Codex adapter assets, run \`lattice codex verify\`. It verifies the manifest, agent mirror, wrapper heartbeat, global heartbeat, and runtime exclusions, then writes process-event evidence consumable by gates.
- Run \`lattice check\` to inspect Lattice managed asset/template drift; after review, use \`lattice check --apply\` or \`lattice check --upgrade\` to sync safe items.
- Initialization scripts can run \`lattice init --verify-codex\` for same-source asset verification.
- When diagnosing the Codex adapter, run \`lattice codex doctor\` to inspect shared checks, health, and worktree state together.
- If \`aux_*\` is unavailable, the current global lattice is core-only. Prefer a local bootstrap entrypoint; if none exists, fall back to shell search as required by AGENTS.md.

Boundaries:

- Do not create \`.Codex/hooks\`; the Codex runtime does not execute Claude Code hooks.
- Do not create \`.Codex/settings.json\`; the Codex runtime does not read Claude Code settings.
- To observe Codex activity, use the wrapper recorded in \`.Codex/lattice.json\` or a fallback invocation with \`KOALA_ACTIVITY_RECORD_READONLY=1\`.
`;

const CODEX_README_LATTICE_THIN_APPENDIX = CODEX_README_THIN_APPENDIX
  .replaceAll('.Codex/koala.json', '.Codex/lattice.json')
  .replaceAll('Koala adapter', 'Lattice adapter');

export function renderCodexReadmeTemplate(assetMode: InitAssetMode = 'full', brand: CodexAdapterBrand = 'lattice'): string {
  const base = brand === 'koala' ? CODEX_README_LEGACY_TEMPLATE : CODEX_README_LATTICE_TEMPLATE;
  const appendix = brand === 'koala' ? CODEX_README_THIN_APPENDIX : CODEX_README_LATTICE_THIN_APPENDIX;
  if (assetMode === 'thin') return `${base}${appendix}`;
  return base;
}

export const CODEX_README_TEMPLATE = renderCodexReadmeTemplate('full');

export function renderCodexAgentContent(content: string): string {
  return renderCodexPromptContent(content);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function renderKoalaBootstrapScript(packageRootAbs: string): string {
  return `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

async function main() {
  const binDir = __dirname;
  const projectRoot = dirname(binDir);
  const coreCliEngineCandidates = [
    join(projectRoot, 'packages', 'main', 'dist', 'cli-engine.js'),
    join(projectRoot, 'node_modules', '@koala-agent', 'core', 'dist', 'cli-engine.js'),
    join(${jsString(packageRootAbs)}, 'dist', 'cli-engine.js'),
  ];

  for (const candidate of coreCliEngineCandidates) {
    if (!existsSync(candidate)) continue;
    const mod = await import(pathToFileURL(candidate).href);
    if (typeof mod.runCli !== 'function') {
      console.error(\`koala local bootstrap candidate has no runCli export: \${candidate}\`);
      process.exit(1);
    }
    await mod.runCli();
    process.exit(0);
  }

  const probe = spawnSync('koala', ['help'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const help = String(probe.stdout || '') + String(probe.stderr || '');
  if (probe.status !== 0 || !help.includes('aux_doc_list') || !help.includes('verify_codex')) {
    console.error('bin/koala.js could not find a local @koala-agent/core CLI engine or a capable global koala.');
    console.error('');
    console.error('Checked local candidates:');
    for (const candidate of coreCliEngineCandidates) console.error(\`  - \${candidate}\`);
    console.error('');
    console.error('Recovery:');
    console.error('  - Install or update @koala-agent/core, then rerun: npx koala-init --verify-codex');
    console.error('  - In the Koala repository, run: npm run build');
    process.exit(1);
  }

  const result = spawnSync('koala', process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

module.exports = { main };

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
`;
}

export function renderLatticeBootstrapScript(packageRootAbs: string): string {
  return renderKoalaBootstrapScript(packageRootAbs)
    .replaceAll('bin/koala.js', 'bin/lattice.js')
    .replaceAll('koala local bootstrap candidate', 'lattice local bootstrap candidate')
    .replace("spawnSync('koala', ['help']", "spawnSync('lattice', ['help']")
    .replace("spawnSync('koala', process.argv.slice(2)", "spawnSync('lattice', process.argv.slice(2)")
    .replaceAll('npx koala-init', 'lattice init')
    .replaceAll('global koala', 'global lattice')
    .replace('In the Koala repository, run: npm run build', 'In the Lattice/Koala repository, run: npm run build');
}

export function renderCodexWrapperScript(): string {
  return `#!/usr/bin/env node
process.env.KOALA_ACTIVITY_SOURCE = 'codex';
process.env.KOALA_ACTIVITY_RECORD_READONLY = '1';
process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

async function main() {
  const [{ existsSync }, { dirname, join }, { pathToFileURL }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ]);
  const binDir = dirname(process.argv[1] || '.');
  const localKoala = join(binDir, 'koala.js');
  if (existsSync(localKoala)) {
    const koala = await import(pathToFileURL(localKoala).href);
    const localMain = koala.main || koala.default?.main;
    if (typeof localMain === 'function') {
      await localMain();
    }
  } else {
    console.error('bin/koala-codex.js did not find a sibling bin/koala.js local bootstrap.');
    console.error('');
    console.error('Recovery:');
    console.error('  - Rerun: npx koala-init --verify-codex');
    console.error('  - If this is the Koala repository, run: npm run build');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
`;
}

export function renderLatticeCodexWrapperScript(): string {
  return renderCodexWrapperScript()
    .replace("const localKoala = join(binDir, 'koala.js');", "const localKoala = join(binDir, 'lattice.js');")
    .replaceAll('bin/koala-codex.js', 'bin/lattice-codex.js')
    .replaceAll('bin/koala.js', 'bin/lattice.js')
    .replaceAll('npx koala-init', 'lattice init')
    .replace('If this is the Koala repository, run: npm run build', 'If this is the Lattice/Koala repository, run: npm run build');
}

export function hookCommand(hookFile: string): string {
  return `node "$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$CLAUDE_PROJECT_DIR")/.claude/hooks/${hookFile}"`;
}

export function getKoalaHooks() {
  return {
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('session-brief-reminder.cjs') }] }],
    PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('log-tools.cjs') }] }],
    PostToolUseFailure: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('log-tools.cjs') }] }],
  };
}
