/**
 * audit-trigger — Dual condition "every N stories + CLAUDE.md has diff" after DONE advance
 * trigger logic (B-9bd9 CHK-003).
 *
 * Responsibilities:
 *   - Read/write `<projectRoot>/.lattice/runtime/framework-audit/state.json` (fields see AuditState)
 *   - Increment doneSinceLastAudit counter
 *   - Determine whether to trigger audit based on config (CHK-004's resolveAuditConfig)
 *   - semi-auto → only return prompt text (no agent spawn); full-auto → run audit handler directly in same process
 *
 * **meta-story exemption**: storyId.startsWith('B-META-') → directly return triggered=false,
 * neither increment counter nor run audit (to avoid nesting when audit-meta-story itself DONEs).
 *
 * **Field ownership split** (coordinates with touchAuditState in audit.ts):
 *   - audit-trigger only manages `doneSinceLastAudit` counter
 *   - audit handler (audit.ts) refreshes `lastAuditAt` and other fields after running
 *   - Under full-auto, audit handler resets the counter in the same process (via its own touchAuditState)
 *
 * Hard design rule: wrap entire function in outer try/catch, any exception → console.warn + return
 * {triggered:false, reason:"error:..."}, **never throw**. DONE hook is never affected by audit trigger.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveAuditConfig, type AuditMode } from './audit-config.js';
import { scanDeprecated } from './audit-scan.js';
import { loadConfig } from './config.js';
import { LATTICE_DIR } from './lattice-paths.js';
import type { WorkflowProfile } from './types.js';

/**
 * state.json schema.
 *
 * - `lastAuditAt`: ISO timestamp of last audit completion (refreshed by audit handler)
 * - `lastAuditCommit`: commit SHA corresponding to last audit (baseline for git log --since; currently managed by audit handler)
 * - `doneSinceLastAudit`: how many stories have been DONE since last audit (maintained by this module)
 * - `lastAuditStoryId`: story id that triggered the last audit (refreshed by audit handler)
 */
export interface AuditState {
  lastAuditAt: string | null;
  lastAuditCommit: string | null;
  doneSinceLastAudit: number;
  lastAuditStoryId: string | null;
}

export interface AuditTriggerResult {
  triggered: boolean;
  /** Human-readable trigger/non-trigger reason (mainly for caller's console.log / stderr output) */
  reason: string;
  /** Prompt text (semi-auto only; under semi-auto the caller should console.log it) */
  hint?: string;
  /** State after write-back (for debugging/testing); error branch may be the initial value */
  stateAfter: AuditState;
}

const INITIAL_STATE: AuditState = {
  lastAuditAt: null,
  lastAuditCommit: null,
  doneSinceLastAudit: 0,
  lastAuditStoryId: null,
};

/**
 * Location of state.json relative to projectRoot.
 * Mutable trigger state lives under ignored `.lattice/runtime/`, deliberately
 * not the legacy `.koala/framework-audit/state.json` path. Some repos tracked
 * that old path before `.koala/` became runtime-only, so writing there made
 * read/status verification appear dirty.
 * Single source of truth: touchAuditState in audit.ts also imports this function to avoid double-hardcoding the path.
 */
export function stateFilePath(projectRoot: string): string {
  return join(projectRoot, LATTICE_DIR, 'runtime', 'framework-audit', 'state.json');
}

/**
 * Read state.json.
 *   - File does not exist → INITIAL_STATE (no disk write)
 *   - JSON.parse failure / not an object → warn + rewrite INITIAL_STATE + return
 *   - Missing fields → fall back to fields from INITIAL_STATE
 */
function readState(projectRoot: string): AuditState {
  const path = stateFilePath(projectRoot);
  if (!existsSync(path)) return { ...INITIAL_STATE };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.warn(`[audit-trigger] failed to read ${path}: ${(err as Error).message}. Resetting state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[audit-trigger] corrupt state.json (${(err as Error).message}). Resetting to initial state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[audit-trigger] state.json not an object. Resetting to initial state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    lastAuditAt: typeof obj.lastAuditAt === 'string' ? obj.lastAuditAt : null,
    lastAuditCommit: typeof obj.lastAuditCommit === 'string' ? obj.lastAuditCommit : null,
    doneSinceLastAudit: typeof obj.doneSinceLastAudit === 'number' && Number.isFinite(obj.doneSinceLastAudit)
      ? obj.doneSinceLastAudit
      : 0,
    lastAuditStoryId: typeof obj.lastAuditStoryId === 'string' ? obj.lastAuditStoryId : null,
  };
}

function writeStateSafe(projectRoot: string, state: AuditState): void {
  const path = stateFilePath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[audit-trigger] failed to write ${path}: ${(err as Error).message}`);
  }
}

/**
 * Does `git log --since=<from> -- CLAUDE.md 'packages/**\/CLAUDE.md'` produce output?
 *
 * - `lastAuditCommit` exists → `--since=<ISO timestamp of that commit's author date>`,
 *   for simplicity the current implementation uses "state.lastAuditAt ?? 30 days ago" as the time window
 *   (the commit SHA as a time anchor only becomes usable once the audit handler writes it; under the current semi-auto mode the commit anchor may be null)
 * - Any git call failure → treated as "no diff" (conservative: not triggering the prompt is more restrained than triggering it by mistake)
 *
 * MVP accepted limitation: under semi-auto mode, if the user keeps ignoring audit prompts, state.lastAuditAt
 * stays null forever, and the fallback 30-day window may miss CLAUDE.md changes that happened close to (>30 days before) the last audit.
 * Later, state.lastAuditCommit (commit SHA) can replace the time window to fully eliminate this limitation.
 */
function claudeMdChangedSince(projectRoot: string, sinceIso: string | null): boolean {
  const since = sinceIso ?? thirtyDaysAgoIso();
  try {
    const out = execSync(
      `git log --since="${since}" --pretty=format:"%H" -- CLAUDE.md 'packages/**/CLAUDE.md'`,
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    ).trim();
    return out.length > 0;
  } catch {
    // git not available / not a git repo → conservatively return false
    return false;
  }
}

function thirtyDaysAgoIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

/** Unified generation of prompt text (with a blank line before and after, as its own paragraph). */
function buildSemiAutoHint(window: number): string {
  return `\n⚠ ${window} story window + CLAUDE.md has changed, suggested run: lattice audit --framework\n`;
}

/**
 * maybeTriggerAudit — called after a successful DONE advance.
 *
 * Normal flow:
 *   1. meta-story → no-op
 *   2. Read state (auto-rebuild if corrupted)
 *   3. Read config (audit mode / window / requireClaudeMdDiff)
 *   4. doneSinceLastAudit++ and write back (note: flush even when mode=off, so counts remain continuous across future off→on switches)
 *   5. mode=off → return triggered=false
 *   6. Window not reached → return triggered=false
 *   7. requireClaudeMdDiff + no CLAUDE.md diff → return triggered=false
 *   8. Trigger:
 *      - semi-auto: return triggered=true with hint (do **not** clear the counter—if the user ignores the hint it will prompt again next time)
 *      - full-auto: call audit handler in the same process, return triggered=true (audit handler is responsible for flushing the other state fields)
 *
 * Any exception is swallowed by the outer try/catch, returning triggered=false + reason.
 */
export async function maybeTriggerAudit(storyId: string, projectRoot: string): Promise<AuditTriggerResult> {
  try {
    // 1. meta-story is exempt from triggering (including counting—avoid nesting)
    //    Return a copy of INITIAL_STATE directly, do not read disk—avoid internal readState exceptions (such as disk corruption)
    //    escaping the outer catch and impacting the DONE flow. The meta-story path does not care about the real state content.
    if (storyId.startsWith('B-META-')) {
      return {
        triggered: false,
        reason: 'meta-story advancement ignored',
        stateAfter: { ...INITIAL_STATE },
      };
    }

    // 2. Read state (self-heals on corruption + returns initial value)
    const prev = readState(projectRoot);

    // 3. Read config
    const cfg = loadConfig(projectRoot);
    const profile: WorkflowProfile = cfg.workflow?.profile ?? 'balanced';
    const auditCfg = resolveAuditConfig(profile, projectRoot);

    // 4. Increment doneSinceLastAudit and persist
    const bumped: AuditState = {
      ...prev,
      doneSinceLastAudit: prev.doneSinceLastAudit + 1,
    };
    writeStateSafe(projectRoot, bumped);

    const mode: AuditMode = auditCfg.mode;

    // 5. mode=off → only flush counter, do not trigger
    if (mode === 'off') {
      return { triggered: false, reason: 'mode=off', stateAfter: bumped };
    }

    // 6. Window not reached
    if (bumped.doneSinceLastAudit < auditCfg.auditTriggerWindow) {
      return {
        triggered: false,
        reason: `window-not-met (${bumped.doneSinceLastAudit}/${auditCfg.auditTriggerWindow})`,
        stateAfter: bumped,
      };
    }

    // 7. requireClaudeMdDiff: detect via git log
    if (auditCfg.requireClaudeMdDiff) {
      const changed = claudeMdChangedSince(projectRoot, prev.lastAuditAt);
      if (!changed) {
        return {
          triggered: false,
          reason: 'no CLAUDE.md diff',
          stateAfter: bumped,
        };
      }
    }

    // 8. Trigger
    if (mode === 'semi-auto') {
      // Prompt only, do not spawn; keep counter uncleared, will keep prompting next time until user actually runs audit
      let hint = buildSemiAutoHint(bumped.doneSinceLastAudit);

      // @deprecated GC advisory (additive only — never changes triggered or blocks DONE)
      const deprecatedResult = scanDeprecated(projectRoot);
      const threshold = auditCfg.deprecatedGcThreshold;
      if (deprecatedResult.count > threshold) {
        const { count, files } = deprecatedResult;
        const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? '...' : '');
        hint += `\n⚠ @deprecated GC: ${count} annotation(s) in ${files.length} file(s) (${fileList}); consider a cleanup story (threshold: ${threshold})`;
      }

      return {
        triggered: true,
        reason: 'semi-auto hint printed',
        hint,
        stateAfter: bumped,
      };
    }

    if (mode === 'full-auto') {
      return await runAuditInProcess(storyId, projectRoot, bumped);
    }

    // In theory resolveAuditConfig has already normalized invalid mode, fallback here
    return { triggered: false, reason: `unknown mode: ${mode}`, stateAfter: bumped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-trigger] error in maybeTriggerAudit: ${msg}`);
    return {
      triggered: false,
      reason: `error: ${msg}`,
      stateAfter: { ...INITIAL_STATE },
    };
  }
}

/**
 * full-auto branch: invoke audit handler in same process (CHK-001 deliverable).
 *
 * audit handler itself will touchAuditState to refresh lastAuditAt; no need to refresh again here.
 * Swallow any exception (audit handler is already advisory internally).
 *
 * Implementation note: use ESM top-level `await import(...)` for runtime dynamic load.
 *   - Don't use `require('node:module')` + createRequire: there's no global require in ESM modules,
 *     and it throws ReferenceError under strict ESM (root cause of F-001/F-014).
 *   - Tradeoff: the CLAUDE.md "core/ does no I/O" constraint applies at the pure code static dependency layer; dynamic import still goes through
 *     the handlers layer, but happens at the runtime boundary, the static import graph is still core→core. We accept
 *     this tradeoff—full-auto is the explicitly chosen "run audit in same process after DONE" mode, which must reach handlers.
 */
async function runAuditInProcess(_storyId: string, projectRoot: string, state: AuditState): Promise<AuditTriggerResult> {
  try {
    const { createAuditHandlers } = await import('../handlers/audit.js');
    const { StoryStore } = await import('./store.js');

    const store = new StoryStore(projectRoot);
    const handlers = createAuditHandlers({
      store,
      root: projectRoot,
      scanRoot: projectRoot,
    });
    handlers.audit({ framework: true });

    return {
      triggered: true,
      reason: 'full-auto executed',
      stateAfter: state,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-trigger] full-auto audit failed: ${msg}`);
    return {
      triggered: false,
      reason: `error: full-auto ${msg}`,
      stateAfter: state,
    };
  }
}

/**
 * Test-friendly: export internal pure function aliases for unit tests to directly verify state read/write.
 * (Only for test, not expected to be called by business code.)
 */
export const _internal = {
  readState,
  writeStateSafe,
  stateFilePath,
  claudeMdChangedSince,
  INITIAL_STATE,
};
