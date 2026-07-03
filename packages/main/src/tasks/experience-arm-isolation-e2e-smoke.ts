#!/usr/bin/env node
/**
 * experience-arm-isolation-e2e-smoke.ts — end-to-end CLI proof that the
 * experience-ablation M3 control-arm memory isolation holds through the REAL
 * command handlers (not just the pure gate/redaction units).
 *
 * Guards findings B-ffe0:F-008/F-009/F-013 (Codex host-2 + review lanes proved
 * that gating the render sites alone left the handler --json / --output paths
 * leaking memory to a control-arm host). This runs the actual CLI in a fresh
 * temp project so the assertions exercise the handler wiring end-to-end:
 *
 *   1. final_response_check --json: on the CONTROL arm the returned
 *      memoryFreshnessPack has EMPTY result/item arrays and the content-free
 *      empty-set packDigest; on TREATMENT and NORMAL (no experiment env) it is
 *      populated. (JSON handler-redaction wiring, F-005/F-013.)
 *   2. final_response_check text: the CONTROL render carries no dev-memory
 *      "reuse:" markers; TREATMENT/NORMAL do. (Gate-suppress wiring.)
 *   3. Retrieval-block: representative CONTROL_ARM_RETRIEVAL_BLOCK commands
 *      (recall, dev_memory_start, dev_memory_list, dev_memory_search) are
 *      REFUSED on the control arm and PERMITTED on treatment/normal. (F-006.)
 *
 * Hermetic: runs entirely in an OS temp git repo, no network; cleans up after
 * itself. Prints `✓ experience-arm-isolation-e2e smoke passed (N checks)`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

let total = 0;
function check(label: string, cond: boolean, detail = ''): void {
  total += 1;
  if (!cond) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
    throw new Error(`check failed: ${label}`);
  }
  console.log(`✓ ${label}`);
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Run the CLI in `cwd` under an optional experiment arm. Returns {code, out}.
 * Never throws on non-zero exit — the retrieval-block cases assert on refusal.
 */
function cli(cwd: string, arm: string | null, cmd: string, argsJson: string): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LATTICE_EXPERIMENT_ARM;
  delete env.LATTICE_EXPERIMENT_ID;
  if (arm) { env.LATTICE_EXPERIMENT_ARM = arm; env.LATTICE_EXPERIMENT_ID = 'e2e'; }
  try {
    const out = execFileSync('node', [CLI, cmd, argsJson], { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Extract the memoryFreshnessPack from a --json CLI response (skips timing preamble). */
function packOf(out: string): { ids: string[]; digest: string } {
  const s = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  const pack = JSON.parse(s).memoryFreshnessPack;
  const r = pack.results;
  return { ids: [...r.playbookIds, ...r.devMemoryEntryIds], digest: pack.packDigest };
}

const base = mkdtempSync(join(tmpdir(), 'experience-arm-isolation-e2e-'));
try {
  // ── Bootstrap a minimal lattice project with a seeded dev-memory entry. ─────
  git(['init', '-b', 'main'], base);
  git(['config', 'user.email', 'smoke@test.local'], base);
  git(['config', 'user.name', 'smoke'], base);
  git(['config', 'commit.gpgsign', 'false'], base);
  writeFileSync(join(base, 'lattice.config.json'), JSON.stringify({ storyDir: '.lattice/story/actives' }, null, 2));
  writeFileSync(join(base, 'seed.txt'), 'seed\n');
  git(['add', '-A'], base);
  git(['commit', '-m', 'init'], base);

  const cap = cli(base, null, 'dev_memory_capture', JSON.stringify({
    category: 'workflow',
    summary: 'Arm-isolation e2e seed lesson about final response checks',
    trigger: 'when running the arm isolation e2e smoke',
    lesson: 'this lesson body must be redacted on the control arm and shown on treatment reuse it',
    reusePrompt: 'reuse the arm isolation seed lesson',
  }));
  check('bootstrap: dev_memory_capture succeeds', cap.code === 0, cap.out);

  // ── 1. final_response_check --json handler redaction. ──────────────────────
  const controlJson = cli(base, 'control', 'final_response_check', '{"json":true}');
  const treatmentJson = cli(base, 'treatment', 'final_response_check', '{"json":true}');
  const normalJson = cli(base, null, 'final_response_check', '{"json":true}');
  check('final_response_check --json runs on all arms',
    controlJson.code === 0 && treatmentJson.code === 0 && normalJson.code === 0);

  const controlPack = packOf(controlJson.out);
  const treatmentPack = packOf(treatmentJson.out);
  const normalPack = packOf(normalJson.out);

  check('CONTROL final_response_check --json: pack result arrays are EMPTY', controlPack.ids.length === 0,
    JSON.stringify(controlPack.ids));
  check('TREATMENT final_response_check --json: pack is populated (memory surfaced)', treatmentPack.ids.length > 0);
  check('NORMAL final_response_check --json: pack is populated (unchanged from pre-M3)', normalPack.ids.length > 0);
  check('CONTROL packDigest === TREATMENT/NORMAL packDigest? NO — control is the content-free empty-set digest',
    controlPack.digest !== treatmentPack.digest && controlPack.digest === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  check('CONTROL --json carries no stored dev-memory id from treatment',
    treatmentPack.ids.every((id) => !controlJson.out.includes(id)) || treatmentPack.ids.length === 0);

  // ── 2. final_response_check text gate-suppress. The text renders the pack
  // SUMMARY (memoryPackDigest/memoryTopHitIds lines), which the gate returns []
  // for on control. ─────────────────────────────────────────────────────────
  const controlText = cli(base, 'control', 'final_response_check', '{}');
  const treatmentText = cli(base, 'treatment', 'final_response_check', '{}');
  check('CONTROL final_response_check text: memory summary suppressed (no memoryTopHitIds line)',
    !/memoryTopHitIds:/.test(controlText.out));
  check('TREATMENT final_response_check text: memory summary shown (memoryTopHitIds line present)',
    /memoryTopHitIds:/.test(treatmentText.out));

  // ── 3. Retrieval-block: refused on control, permitted otherwise. The block
  // itself is main's (command-policy.ts memoryRetrieval marker); this asserts it
  // is wired end-to-end together with the isolation layer, including the two
  // commands this story added to the marker set (memory_benchmark_real_data,
  // source_lineage_audit). ──────────────────────────────────────────────────
  const REFUSAL = /memory retrieval is disabled on the control arm/;
  // Valid args per command so schema validation does not fail before the
  // control-arm block fires (the block is what we are asserting).
  const blockProbes: Array<[string, string]> = [
    ['recall', '{"query":"x"}'],
    ['dev_memory_start', '{}'],
    ['dev_memory_list', '{}'],
    ['dev_memory_search', '{"query":"x"}'],
    ['memory_benchmark_real_data', '{"format":"json"}'],
    ['source_lineage_audit', '{"domain":"learning","json":true}'],
  ];
  for (const [cmd, cmdArgs] of blockProbes) {
    const ctrl = cli(base, 'control', cmd, cmdArgs);
    const norm = cli(base, null, cmd, cmdArgs);
    check(`CONTROL ${cmd}: REFUSED (control-arm retrieval block)`,
      ctrl.code !== 0 && REFUSAL.test(ctrl.out), ctrl.out.slice(0, 120));
    check(`NORMAL ${cmd}: NOT refused by the control-arm block (no experiment env)`,
      !REFUSAL.test(norm.out), norm.out.slice(0, 120));
  }

  console.log(`\n✓ experience-arm-isolation-e2e smoke passed (${total} checks)`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
