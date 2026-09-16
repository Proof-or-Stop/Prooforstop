import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reusable INIT reviewer delivery over the REAL acknowledged managed-dispatch path.
 *
 * `init_check_set` is only accepted from inside a live, controller-owned
 * `managed_dispatch` provider invocation; a bare CLI call is refused with
 * `[delivery_not_acknowledged]`. Tests whose subject is INDEPENDENT reviewer
 * coverage therefore cannot call `init_check_set` directly, and must not be
 * converted to the `init_check_repair` fallback: that fallback records
 * mechanically distinct `<required>@fallback` identities, which would change
 * what those tests verify.
 *
 * This helper reproduces the shape proven by
 * `packages/main/tests/managed-init-reviewer-dispatch-e2e.test.mjs`: a fake
 * `codex` provider shim on PATH, host-run handlers built with the in-process
 * `launchWorker` test seam, and the exact operator flow CLAUDE.md documents for
 * INIT (`host_run ... managedDispatch:true, detach:true`, then a bounded
 * `host_run_status` wait). The shim receives the canonical dispatch prompt on
 * stdin and calls `init_check_set` from inside that dispatch's own provider
 * invocation, which is what satisfies the acknowledgement.
 *
 * Nothing here weakens the requirement: the controller signs the invocation,
 * the CLI verifies and atomically consumes it, and every recorded reviewer row
 * carries the managed delivery run id it was produced under.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const distRoot = join(packageRoot, 'dist');
const defaultCliPath = join(distRoot, 'cli.js');

const { createHostRunHandlers } = await import(join(distRoot, 'handlers/host-run.js'));
const { runManagedHostRunWorker } = await import(join(distRoot, 'core/managed-host-run.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Write a fake `codex` provider that records the delivered prompt and then runs
 * exactly one `init_check_set` from inside the managed dispatch invocation.
 */
function writeProviderShim({ binDir, cliPath, root, storyId, agentType, issues, promptPath }) {
  const providerPath = join(binDir, 'codex');
  const payload = JSON.stringify({ storyId, issues, agentId: agentType });
  writeFileSync(providerPath, [
    '#!/bin/sh',
    'set -eu',
    // The managed worker delivers the canonical dispatch prompt on the provider's stdin.
    `cat > ${shellQuote(promptPath)}`,
    `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --root ${shellQuote(root)} init_check_set ${shellQuote(payload)}`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    '',
  ].join('\n'), { encoding: 'utf8' });
  chmodSync(providerPath, 0o755);
  return providerPath;
}

/**
 * Deliver ONE required INIT reviewer verdict through a real managed dispatch.
 *
 * Each call creates its own managed dispatch run, because a dispatch invocation
 * is single-use: the signed attestation (and the process-group receipt) is
 * consumed atomically by the first `init_check_set` that uses it.
 *
 * @param {object} args
 * @param {string} args.root fixture repository root (never a live checkout)
 * @param {string} args.storyId Story to deliver INIT evidence for
 * @param {string} [args.agentType] required reviewer identity to deliver as
 * @param {Array} [args.issues] issues the reviewer reports (default: none)
 * @param {object} [args.hostRun] extra/override `host_run` fields, so a caller can
 *   execute a documented template verbatim with only the Story id substituted
 * @returns {Promise<{runId: string, prompt: string, terminal: object, hostRunArgs: object}>}
 */
export async function deliverInitReviewerVerdict({
  root,
  storyId,
  agentType,
  issues = [],
  hostRun = {},
  store = new StoryStore(root),
  cliPath = defaultCliPath,
  waitMs = 30_000,
  waitDeadlineMs = 180_000,
}) {
  const resolvedAgentType = agentType ?? hostRun.agentType;
  assert.ok(resolvedAgentType, 'managed INIT delivery needs an agentType');
  if (agentType && hostRun.agentType) {
    assert.equal(hostRun.agentType, agentType, 'host_run agentType must match the delivered reviewer identity');
  }

  const stage = mkdtempSync(join(tmpdir(), 'proof-or-stop-managed-init-delivery-'));
  const binDir = join(stage, 'bin');
  mkdirSync(binDir, { recursive: true });
  const promptPath = join(stage, 'delivered-prompt.txt');
  writeProviderShim({ binDir, cliPath, root, storyId, agentType: resolvedAgentType, issues, promptPath });

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  try {
    const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
      launchWorker: async request => {
        void runManagedHostRunWorker(request, { env: { ...process.env } });
        return { pid: process.pid };
      },
    });
    const hostRunArgs = {
      host: 'codex',
      ...hostRun,
      storyId,
      agentType: resolvedAgentType,
      managedDispatch: true,
      detach: true,
      json: true,
    };
    const submitted = await handlers.host_run(hostRunArgs);
    const runId = submitted?.run?.runId ?? submitted?.runId;
    assert.ok(typeof runId === 'string' && runId.length > 0,
      `managed INIT dispatch must return a non-empty run id: ${JSON.stringify(submitted)}`);

    // Bounded wait, exactly as the documented operator flow prescribes.
    const giveUpAt = Date.now() + waitDeadlineMs;
    let status;
    for (;;) {
      status = await handlers.host_run_status({ runId, waitMs, json: true });
      if (status?.run?.terminal) break;
      assert.ok(Date.now() < giveUpAt,
        `managed INIT dispatch ${runId} for ${resolvedAgentType} never reached a terminal state`);
    }
    const terminal = status.run.terminal;
    assert.equal(terminal.state, 'completed',
      `managed INIT dispatch for ${resolvedAgentType} did not complete: ${JSON.stringify(terminal)}`);
    const prompt = readFileSync(promptPath, 'utf8');
    assert.ok(prompt.length > 0, 'the managed provider must receive the canonical dispatch prompt on stdin');
    return { runId, prompt, terminal, hostRunArgs };
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Deliver a sequence of required INIT reviewer verdicts, one managed dispatch
 * each, in the given order. Order matters: `init-check.json` records reviewer
 * rows in arrival order and several contracts assert that order.
 *
 * @param {Array<string|{agentType?: string, agentId?: string, issues?: Array, hostRun?: object}>} reviewers
 * @returns {Promise<Array<{agentType: string, runId: string, prompt: string, terminal: object}>>}
 */
export async function deliverInitReviewerVerdicts({ reviewers, ...shared }) {
  const delivered = [];
  for (const entry of reviewers) {
    const reviewer = typeof entry === 'string' ? { agentType: entry } : entry;
    const agentType = reviewer.agentType ?? reviewer.agentId;
    const result = await deliverInitReviewerVerdict({
      ...shared,
      agentType,
      issues: reviewer.issues ?? [],
      ...(reviewer.hostRun ? { hostRun: reviewer.hostRun } : {}),
    });
    delivered.push({ agentType: agentType ?? result.hostRunArgs.agentType, ...result });
  }
  return delivered;
}
