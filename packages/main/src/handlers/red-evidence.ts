/**
 * Red-evidence CLI commands for the trusted RED-evidence subsystem.
 *
 *   - `red_evidence_binding_set` (W2b / B-e10d) registers the per-story target
 *     binding (§1.1.3). W2c ADDS the §1.1.3 binding-FREEZE rule now that
 *     chain-head semantics exist.
 *   - `red_evidence_quarantine` / `red_evidence_recover` (W2c / B-506e) append the
 *     two chain-control records (§4.1), owner-gated and serialized under one
 *     mkdir claim (append.ts), with a DERIVED `approvedBy` and the §3.3 write-time
 *     expectedRedTargets membership gate (CHK-012).
 *   - `red_evidence_envelope_check` (W2d / B-9ff1) is READ-ONLY: it validates a
 *     candidate §1.1 assertion envelope against the resolved policy and the
 *     story's COMMITTED target binding so an operator learns the envelope is
 *     inadmissible — with a correctly tagged §1.6 reason — BEFORE spending a
 *     run. It follows the read-only house pattern of `acceptance_topology_check`,
 *     `topology_critic_receipt_check` and `proofstory_gate_check`: derived
 *     output only, no caller-submitted status, and an inadmissible verdict is
 *     surfaced by THROWING the rendered report (non-zero exit) rather than by
 *     recording it as RED evidence. The throw is NOT verdict-free everywhere:
 *     the CLI catch path in cli-engine.ts passes `e.message` into `writeLog`,
 *     so under either activity-log bypass the full tagged report is stored in
 *     the `.proof-or-stop/activity.jsonl` row's `error` field, and a CONFIGURED and
 *     MATCHING `onError` hook runs on that same path (that call site has no
 *     read-only predicate; MATCHING because `resolveHookCommands` in
 *     `core/hooks.ts` resolves an exact stage-map key plus `*` and nothing
 *     else, so a hooks map carrying neither runs no command at all). See the
 *     fence note on the handler itself.
 *
 * Authorization is layered exactly like every other mutating story command:
 *   1. The story-owner LEASE is enforced UPSTREAM at the single CLI choke point
 *      (cli-engine enforceStoryOwnerLeaseGate) because command-policy classifies
 *      all three as `storyScopedMutating`. A foreign active lease rejects the
 *      command before the handler runs (§4.1).
 *   2. Actor MUTATION AUTHORITY is resolved here via resolveAgentMutationAuthority
 *      — a dispatched role without the authority fails closed, independently of
 *      lease ownership.
 *
 * These commands change NO existing gate verdict: the v2 chain records they write
 * are invisible to the v1 gate predicate (proofstory.ts skips them by schema
 * discriminator), and no gate consumes the chain in this leaf.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import type { HandlerContext } from './context.js';
import { StoryStore } from '../core/store.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { getSessionId } from '../core/owner-session.js';
import { loadConfig } from '../core/config.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resolveExpectedRedTargets, type ExpectedRedTargetsInput } from '../core/proofstory.js';
import { readTrustedProofStoryScopeArtifacts } from '../core/closeout-trust.js';
import {
  appendTargetBinding,
  emptyRedTargetBindingsFile,
  findTargetBinding,
  readCommittedTargetBindings,
  targetBindingDigest,
  RED_TARGET_BINDINGS_FILENAME,
  type RedTargetBindingEntry,
} from '../core/red-evidence/target-bindings.js';
import { resolveRedEvidencePolicy } from '../core/red-evidence/policy.js';
import { validateAssertionEnvelope } from '../core/red-evidence/envelope.js';
import { isRedEvidenceV2, type RedEvidenceRecordV2 } from '../core/red-evidence/record-v2.js';
import { partitionChain, resolveChainHead } from '../core/red-evidence/chain.js';
import { controlOperationKey } from '../core/red-evidence/operation-key.js';
import {
  appendControlRecord,
  redEvidenceChainLockDir,
  REASON_CORRUPT_CHAIN,
  type AppendResult,
} from '../core/red-evidence/append.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import type { RedEvidenceData } from '../core/types.js';
import {
  describeRedEvidenceReadFailure,
  redEvidenceRepairGuidance,
  renderRedEvidenceQuarantineNotice,
} from '../core/red-evidence-artifact-validation.js';

function withBindingLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.runtimeLockDirPath(storyId, 'red-target-bindings', 'red-target-bindings');
  return withMkdirLock(lockDir, fn, { label: 'red-target-bindings metadata' });
}

/**
 * B-2aa7 CHK-006 (§10.4 rows C2/C3) — the chain commands' read of the artifact.
 *
 * Both chain commands read `red-evidence.json` and then write a REBUILT envelope
 * through `appendControlRecord` (`core/red-evidence/append.ts`, owned by the
 * merged sibling B-506e and OUTSIDE this story's write set). That rebuild does
 * not restore D-4 quarantined originals to `records`, so running it against a
 * corrupt artifact would relocate — and, on any later non-spreading append,
 * destroy — evidence the operator is trying to repair. Since the rebuild cannot
 * be fixed from here, the command REFUSES instead, which is C2's second branch:
 * a controlled failure naming the corruption and the repair path, never a silent
 * rewrite and never an abort that reads as "not configured".
 *
 * `red_evidence_create` is unaffected by this refusal and remains the CLI repair
 * path (it restores quarantined originals before writing), so the artifact is
 * never left unrepairable through the CLI.
 */
function readRedEvidenceForChain(
  store: StoryStore,
  storyId: string,
  command: string,
): RedEvidenceData | null {
  let data: RedEvidenceData | null;
  try {
    data = store.readRedEvidence(storyId);
  } catch (e) {
    const corruption = describeRedEvidenceReadFailure(e);
    if (corruption === null) throw e;
    throw new Error(
      `${command} refused: this story's red-evidence artifact cannot be read, so its chain state is unknown. ` +
        `Nothing written.\n${corruption}\n${redEvidenceRepairGuidance(storyId)}`,
    );
  }
  const corruption = renderRedEvidenceQuarantineNotice(storyId, data);
  if (corruption !== null) {
    throw new Error(
      `${command} refused: this story's red-evidence artifact holds quarantined record(s), and appending to the chain ` +
        `rebuilds the envelope without restoring them. Nothing written.\n${corruption}\n` +
        `${redEvidenceRepairGuidance(storyId)}`,
    );
  }
  return data;
}

/** Locate a v2 chain record by id within a story's store (§4.1 reference lookup). */
function findV2Record(store: StoryStore, storyId: string, recordId: string): RedEvidenceRecordV2 {
  const data = readRedEvidenceForChain(store, storyId, 'red_evidence chain reference');
  const record = (data?.records ?? []).find(
    (r): r is RedEvidenceRecordV2 => isRedEvidenceV2(r) && r.id === recordId,
  );
  if (!record) {
    throw new Error(
      `red_evidence chain reference refused: record "${recordId}" is not a v2 chain record in story ${storyId} ` +
        `(a nonexistent id, or a record from a different story, is rejected — §4.1)`,
    );
  }
  return record;
}

/**
 * The EXACT slice `resolveExpectedRedTargets` reads (§3.3), and nothing else.
 *
 * B-2aa7 F-005. This used to build a whole `proofStoryDiagnosticInput`, whose
 * many fields include an eager `store.readRedEvidence()`. `resolveExpectedRedTargets`
 * never looks at `redEvidence` — it reads only the three fields below (proofstory.ts
 * `ExpectedRedTargetsInput`) — so that coupling made a corrupt `red-evidence.json`
 * abort a membership decision that does not depend on it, through the ONE call site
 * of the shared builder that was not wrapped in `withRedEvidenceCorruptionContext`
 * (phase-gates.ts wraps both of its own). The operator got a bare
 * `RedEvidenceArtifactError` with no repair guidance.
 *
 * Dropping the read is preferred over wrapping it because wrapping would report a
 * failure this gate cannot honestly claim: the membership inputs ARE readable, so
 * "the gate has no evidence to evaluate" would be false and misattributed. Each read
 * should report its own failure. `red_evidence_binding_set` still surfaces the
 * corruption — at `readRedEvidenceForChain`, the read that genuinely needs the
 * artifact and already attaches `redEvidenceRepairGuidance` — and because that is now
 * the command's ONLY artifact read, which message the operator sees no longer depends
 * on which of two reads fires first. `red_evidence_quarantine` / `red_evidence_recover`
 * are unaffected: their `findV2Record` already reads through that same wrapper first.
 *
 * The computed set is UNCHANGED (same three fields, same store readers, same
 * resolver), so no membership verdict moves.
 */
function expectedRedTargetsInput(store: StoryStore, storyId: string): ExpectedRedTargetsInput {
  return {
    originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
    proofStoryContract: store.readProofStoryContract(storyId),
    milestoneLedger: readTrustedProofStoryScopeArtifacts(store, storyId).ledger,
  };
}

/** §3.3 write-time expectedRedTargets membership gate (CHK-012), case-sensitive. */
function assertTargetInExpected(store: StoryStore, storyId: string, acceptanceTargetRef: string, command: string): void {
  const expected = resolveExpectedRedTargets(expectedRedTargetsInput(store, storyId));
  if (!expected.has(acceptanceTargetRef)) {
    throw new Error(
      `${command}: derived acceptanceTargetRef "${acceptanceTargetRef}" is not in expectedRedTargets for ${storyId} ` +
        `(§3.3 write-time membership gate; nothing written). Known targets: ${expected.size === 0 ? '<none>' : [...expected].join(', ')}`,
    );
  }
}

/** The DERIVED `approvedBy` = `<actor>@<sessionId>` (§4.1) — never a caller arg. */
function deriveApprovedBy(actor: string | undefined): string {
  return `${actor ?? 'unknown'}@${getSessionId()}`;
}

/**
 * Resolve the operator's `assertionFile` argument to an absolute path.
 *
 * Deterministic order: an absolute path is used verbatim; a relative path is
 * resolved against the PROJECT ROOT first (the repo-relative convention every
 * other path argument in this CLI follows) and only then against the process
 * cwd, so the same argument means the same file regardless of which subdirectory
 * the operator happens to stand in.
 */
function resolveAssertionFilePath(root: string, assertionFile: string): string {
  if (isAbsolute(assertionFile)) return assertionFile;
  const fromRoot = resolvePath(root, assertionFile);
  if (existsSync(fromRoot)) return fromRoot;
  return resolvePath(process.cwd(), assertionFile);
}

/**
 * §1.1.3 anti-swap lookup for the envelope CHECK: read the story's target
 * binding from the COMMITTED tree at HEAD (W2b `readCommittedTargetBindings`),
 * never the live story directory — the same rule the runner follows, so the
 * pre-flight answers the question the run will actually ask. An uncommitted or
 * post-review edit is invisible here on purpose.
 *
 * Returns null when the story has no committed bindings file or no entry for the
 * target; the envelope validator turns that into the §1.6 R1-6 rejection.
 */
function readCommittedBindingForTarget(
  store: StoryStore,
  root: string,
  storyId: string,
  acceptanceTargetRef: string | null,
): RedTargetBindingEntry | null {
  if (!acceptanceTargetRef) return null;
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  let storyRel: string;
  try {
    storyRel = relative(realpathSync(gitCwd), realpathSync(store.storyDirPath(storyId)));
  } catch {
    storyRel = relative(gitCwd, store.storyDirPath(storyId));
  }
  const relPath = join(storyRel, RED_TARGET_BINDINGS_FILENAME).replace(/\\/g, '/');
  let file;
  try {
    file = readCommittedTargetBindings({ gitCwd, ref: 'HEAD', relPath });
  } catch (error) {
    throw new Error(
      `red_evidence_envelope_check: could not read the COMMITTED target bindings at HEAD:${relPath} — ${(error as Error).message}. ` +
        'Scoped to the command handler itself and the CLI story-evidence writers, it writes no RED-evidence record, ' +
        'chain record or story/evidence artifact, emits no process event, changes no gate verdict, and runs no ' +
        'preCommand or postCommand hook. Nothing outside that scope is covered: see the red_evidence_envelope_check ' +
        'note in cli/activity-policy.ts, which lists the surfaces known when it was written and is not a proof of ' +
        'exhaustiveness. It is thrown, so a CONFIGURED and MATCHING onError hook does run — MATCHING means the hooks ' +
        'map carries an exact red_evidence_envelope_check key or a * key, and a map with neither runs no command at ' +
        'all — and the CLI may record this text in the error field of a .proof-or-stop/activity.jsonl row.',
    );
  }
  if (!file) return null;
  return findTargetBinding(file, acceptanceTargetRef) ?? null;
}

export function createRedEvidenceHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    red_evidence_binding_set(args: {
      storyId: string;
      acceptanceTargetRef: string;
      adapterId: string;
      testCaseRef: string;
      agent?: string;
      actor?: string;
    }): string {
      resolveAgentMutationAuthority({
        command: 'red_evidence_binding_set',
        payloadActors: [args.agent, args.actor],
      });

      const acceptanceTargetRef = String(args.acceptanceTargetRef ?? '').trim();
      const adapterId = String(args.adapterId ?? '').trim();
      const testCaseRef = String(args.testCaseRef ?? '').trim();
      if (!acceptanceTargetRef || !adapterId || !testCaseRef) {
        throw new Error(
          'red_evidence_binding_set: acceptanceTargetRef, adapterId, and testCaseRef must each be non-blank strings',
        );
      }

      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // §3.3 write-time membership gate (case-sensitive).
      assertTargetInExpected(store, args.storyId, acceptanceTargetRef, 'red_evidence_binding_set');

      return withBindingLock(store, args.storyId, () => {
        // §1.1.3 binding-FREEZE (W2c): a binding is FROZEN once a run record
        // exists on an UNQUARANTINED chain for the target. Setting is legal while
        // the chain is EMPTY or its head is a `quarantine` record; a run-record
        // head (red-assert / green-confirm / a recover reinstating one) freezes
        // the binding — retire the assertion (quarantine) first.
        //
        // F-009: the freeze READ and the binding WRITE MUST be serialized with
        // chain appends (quarantine/recover) for THIS target, or a concurrent
        // recover could reinstate a run head BETWEEN the read and the write and
        // bypass the freeze. Hold the SAME per-(story,target) chain lock the
        // append pipeline uses so the read+decision+write is atomic w.r.t.
        // appends. (Lock order: binding lock outer, chain lock inner; chain
        // appends take ONLY the chain lock, so no ordering cycle / deadlock.)
        const chainLock = redEvidenceChainLockDir(store, args.storyId, acceptanceTargetRef);
        return withMkdirLock(
          chainLock,
          () => {
            // B-2aa7 CHK-006: the freeze decision below is derived from the
            // chain, so a corrupt artifact means the decision would be made from
            // a PARTIAL view of the file. Fail closed and say so — the same
            // stance the corrupt-chain guard immediately below already takes.
            const evidence = readRedEvidenceForChain(store, args.storyId, 'red_evidence_binding_set');
            const chain = partitionChain(evidence?.records ?? [], args.storyId, acceptanceTargetRef);
            const head = resolveChainHead(chain);
            // F-007: a NON-empty chain with no unique head is CORRUPT — never
            // treat a null head from a malformed chain as "empty and settable"
            // (mirror the append.ts corrupt-chain guard). Fail closed.
            if (chain.length > 0 && head === null) {
              throw new Error(
                `red_evidence_binding_set: the target chain for "${acceptanceTargetRef}" has no unique head ` +
                  `(${REASON_CORRUPT_CHAIN}, §3.2) — a malformed non-empty chain is not a settable/empty chain; nothing written.`,
              );
            }
            if (head && head.operation !== 'quarantine') {
              throw new Error(
                `red_evidence_binding_set: the target binding for "${acceptanceTargetRef}" is FROZEN — a run record exists on an ` +
                  `unquarantined chain (head operation "${head.operation}", §1.1.3). Quarantine the head first to rebind.`,
              );
            }

            const existing = store.readRedTargetBindings(args.storyId) ?? emptyRedTargetBindingsFile(args.storyId);
            const updated = appendTargetBinding(existing, { acceptanceTargetRef, adapterId, testCaseRef });
            store.writeRedTargetBindings(args.storyId, updated);

            const digest = targetBindingDigest({ acceptanceTargetRef, adapterId, testCaseRef });
            const commitHint = autoCommitStoryMetadata(root, args.storyId, 'red_evidence_binding_set');
            return `Target binding recorded for ${args.storyId} ${acceptanceTargetRef} → adapter=${adapterId} test=${testCaseRef} (targetBindingDigest ${digest})${commitHint}`;
          },
          { label: 'red-evidence chain (binding freeze)' },
        );
      });
    },

    /**
     * W2d (B-9ff1) — READ-ONLY §1.1 envelope admissibility pre-flight.
     *
     * `red_evidence_envelope_check(storyId, assertionFile)` answers ONE question:
     * would this candidate assertion envelope be admissible, and if not, WHICH
     * §1.6 rejection class does it fall in? It exists so an operator learns an
     * envelope is inadmissible with a correctly tagged reason BEFORE spending a
     * run.
     *
     * §5.5 FENCE NOTE: §5.5 fences the W2/W3 boundary — W2 defines and answers
     * the single gate-consumption QUERY, W3 wires gates to consume the answer.
     * This command is not that query and is not a new query surface added to
     * satisfy an enforcement need: it consumes no chain, returns no target
     * verdict, is consumed by no gate, and changes no gate verdict. It is an
     * operator pre-flight over a candidate file that is not evidence yet, so it
     * sits OUTSIDE the §5.5 fence.
     *
     * READ-ONLY, mechanically, in the canonical scope sentence used verbatim at
     * every site that states this guarantee: Scoped to the command handler
     * itself and the CLI story-evidence writers, it writes no RED-evidence
     * record, chain record or story/evidence artifact, emits no process event,
     * changes no gate verdict, and runs no preCommand or postCommand hook. The
     * handler reads config, the story record, the candidate file, and the
     * COMMITTED bindings blob; it additionally spawns no RED run and never calls
     * autoCommitStoryMetadata. Nothing outside that scope is covered: see the
     * red_evidence_envelope_check note in `cli/activity-policy.ts`, which lists
     * the surfaces known when it was written and is not a proof of
     * exhaustiveness — the same set repeated as 1-4 below.
     * `command-policy` classifies the command `readOnly`/`destructiveRisk: none`
     * and `cli/activity-policy` lists it in READ_ONLY_COMMANDS, which suppresses
     * exactly TWO of the CLI's own write surfaces — the `preCommand` and
     * `postCommand` hooks, and `writeCodexProcessEvent`'s class-wide early
     * return — because those are the ones gated on `isReadOnlyCommand` alone,
     * with no second term.
     *
     * SURFACES THAT CLASSIFICATION DOES NOT SETTLE. Stated plainly, because the
     * guarantee above is easy to over-read into "this command causes no write at
     * all", which is false. This is the set known when it was written, not a
     * proof of exhaustiveness:
     *   1. THE `onError` HOOK RUNS. Its call site in `cli-engine.ts` carries no
     *      read-only predicate: the `runHooks('onError', ...)` call there is
     *      UNCONDITIONAL, and `config0?.hooks?.onError` guards only the
     *      informational stderr notice printed just above it. The filtering is
     *      inside `runHooks` in `core/hooks.ts` — absent config, unknown stage,
     *      and no exact/wildcard key match or no resolved commands each return
     *      early — so a CONFIGURED and MATCHING onError hook runs whenever the
     *      command throws. This command throws its rendered rejection report BY
     *      DESIGN, so that is its primary failure route, not an edge case. Such
     *      a hook is not bounded by anything above: `spawnHook` in
     *      `core/hooks.ts` executes it through `/bin/sh -c` in the project root,
     *      so it can write RED or story evidence, append a process event, or
     *      invoke a gate-mutating command. AND THE REPORT STRADDLES IT, because
     *      the catch block in `cli-engine.ts` prints the report TWICE: it OPENS
     *      with a `log(...)` failure diagnostic carrying `e.message`, which is
     *      emitted BEFORE `await runHooks('onError', ...)`, and CLOSES with the
     *      `process.stderr.write('Error: ' + e.message)` that follows the same
     *      await. So the first copy predates the hook and the second postdates
     *      it, and nothing in the text distinguishes them — a reader cannot tell
     *      which copy is in front of them. That is why the rejection text below
     *      states the scope and then discloses BOTH prints, rather than
     *      asserting an unqualified "nothing was written" or a single ordering.
     *      Do not "fix" this by adding a guard here, and do not move or drop
     *      either print site to make a tidier claim true: the onError call site
     *      and its surrounding diagnostics are class-wide and belong to a
     *      separate change.
     *   2. ONE ACTIVITY ROW MAY BE APPENDED. The shared CLI entrypoint still
     *      appends one generic session row to `.proof-or-stop/activity.jsonl` when
     *      `PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1` (the documented Codex heartbeat
     *      mode) or while the story carries an uncooled stale warning — see the
     *      `red_evidence_envelope_check` note in `cli/activity-policy.ts`, which
     *      names both paths. That file is NOT outside this repository's artifact
     *      taxonomy: `core/runtime-artifact-registry.ts` registers it as the
     *      `runtime-activity-log` artifact. And the CLI catch path passes
     *      `e.message` into `writeLog`, which stores it in the row's `error`
     *      field — so when the row is written, the full rendered rejection
     *      verdict IS recorded there.
     *   3. THE OWNER-SESSION TOKEN STORE. Before appending that row, `writeLog`
     *      resolves session identity via `getSessionIdentity`
     *      (`core/owner-session.ts`); under the generated-token adapter mode that
     *      path reaches `readOrCreateOwnerSessionToken`, creating or refreshing a
     *      file under `.proof-or-stop/runtime/owner-session-tokens/` — registered
     *      SEPARATELY in `core/runtime-artifact-registry.ts` as the
     *      `owner-session-token-store` artifact.
     *   4. THE HEALTH LOG. When activity or hook persistence FAILS,
     *      `reportHealthIssue` (`core/health.ts`) appends one JSONL row to the
     *      health log — `~/.proof-or-stop/health.jsonl` by default, which is outside
     *      the project tree. Only the DEFAULT is: `getHealthPath` returns
     *      `PROOF_OR_STOP_HEALTH_PATH` verbatim when set, with no containment check,
     *      so an override can name a path inside the story directory. The note
     *      in `cli/activity-policy.ts` states what that does and does not do to
     *      the scope sentence.
     *
     * IT DOES SPAWN, and the set is enumerated here because a claim nobody can
     * check is worth nothing (the committed regression
     * packages/main/tests/red/red-w2d-command-readonly.mjs records
     * `child_process` and asserts exactly this set, so the list below is
     * observed rather than asserted from memory). Two families, both read-only
     * git: (1) repository/worktree RESOLUTION — `git rev-parse --show-toplevel`,
     * `git rev-parse --git-common-dir`, `git worktree list --porcelain` — needed
     * before a committed path can be named at all; and (2) the W2b
     * committed-tree READ itself — `git rev-parse --verify --quiet <ref>^{commit}`
     * then `git show <ref>:<path>`. Reading the binding from the committed tree
     * rather than the live story directory is §1.1.3's anti-swap property, so
     * that read is deliberate and must not be removed. What never happens is an
     * envelope EXECUTION: no runner, no harness, no package manager, no shell.
     *
     * An INADMISSIBLE envelope THROWS the rendered report (so the CLI exits
     * non-zero and a script cannot mistake a rejection for a pass), which is the
     * same enforce-shape the read-only ProofStory checkers use.
     */
    red_evidence_envelope_check(args: { storyId: string; assertionFile: string; json?: boolean }): string {
      const storyId = String(args.storyId ?? '').trim();
      if (!storyId) throw new Error('red_evidence_envelope_check: storyId is required');
      const assertionFileArg = String(args.assertionFile ?? '').trim();
      if (!assertionFileArg) {
        throw new Error('red_evidence_envelope_check: assertionFile is required (path to the candidate §1.1 assertion envelope JSON)');
      }

      try {
        store.readStory(storyId);
      } catch {
        throw new Error(`Story ${storyId} not found`);
      }

      const assertionPath = resolveAssertionFilePath(root, assertionFileArg);
      if (!existsSync(assertionPath)) {
        throw new Error(`red_evidence_envelope_check: assertion file not found: ${assertionPath}`);
      }
      let assertion: unknown;
      try {
        assertion = JSON.parse(readFileSync(assertionPath, 'utf-8'));
      } catch (error) {
        throw new Error(`red_evidence_envelope_check: ${assertionPath} is not valid JSON — ${(error as Error).message}`);
      }

      // Fail closed on an unresolvable policy: without §1.2 bounds and floors
      // there is nothing to validate against, and guessing defaults would answer
      // a question the project has not configured.
      const policyResult = resolveRedEvidencePolicy(loadConfig(root).redEvidence);
      if (!policyResult.ok) {
        throw new Error(
          `red_evidence_envelope_check: the red-evidence policy does not resolve, so no envelope can be validated (fail-closed):\n${policyResult.diagnostics
            .map((diagnostic) => `  - ${diagnostic.message}`)
            .join('\n')}\nSet these under the "redEvidence" block in proof-or-stop.config.json at the project root; run \`proof-or-stop doctor\` to see the resolved red-evidence policy.`,
        );
      }

      const acceptanceTargetRef =
        typeof (assertion as { acceptanceTargetRef?: unknown })?.acceptanceTargetRef === 'string'
          ? String((assertion as { acceptanceTargetRef?: unknown }).acceptanceTargetRef)
          : null;
      const committedBinding = readCommittedBindingForTarget(store, root, storyId, acceptanceTargetRef);

      const result = validateAssertionEnvelope({
        assertion,
        policy: policyResult.snapshot,
        policyDigest: policyResult.policyDigest,
        committedBinding,
      });

      const report = {
        schemaVersion: 'proofstory.red_evidence_envelope_check.v1' as const,
        ok: result.ok,
        storyId,
        assertionFile: assertionPath,
        policyDigest: policyResult.policyDigest,
        assertionDigest: result.assertionDigest,
        binding: result.binding,
        rejections: result.rejections,
        diagnostics: result.diagnostics,
      };

      if (result.ok) {
        if (args.json) return JSON.stringify(report, null, 2);
        return [
          'Red-evidence envelope: ADMISSIBLE',
          `Story: ${storyId}`,
          `Envelope: ${assertionPath}`,
          `Acceptance target: ${result.binding?.acceptanceTargetRef ?? '<none>'}`,
          `Matched binding: adapterId=${result.binding?.adapterId ?? '<none>'} testCaseRef=${result.binding?.testCaseRef ?? '<none>'} (committed tree, HEAD)`,
          `assertionDigest: ${result.assertionDigest}`,
          `policyDigest: ${policyResult.policyDigest}`,
          'Scoped to the command handler itself and the CLI story-evidence writers, it writes no RED-evidence record, chain record or story/evidence artifact, emits no process event, changes no gate verdict, and runs no preCommand or postCommand hook. Nothing outside that scope is covered: see the red_evidence_envelope_check note in cli/activity-policy.ts, which lists the surfaces known when it was written and is not a proof of exhaustiveness.',
          'It validated the envelope and executed no envelope and no RED run. It does spawn read-only git reads to resolve the workspace and read the committed binding. Running the RED evidence is a separate step.',
        ].join('\n');
      }

      const text = [
        'Red-evidence envelope: NOT ADMISSIBLE',
        `Story: ${storyId}`,
        `Envelope: ${assertionPath}`,
        `policyDigest: ${policyResult.policyDigest}`,
        `Rejections (§1.6): ${result.rejections.length}`,
        ...result.rejections.map((rejection) => `  - [${rejection.tag}] ${rejection.code}: ${rejection.message}`),
        `Diagnostics: ${result.diagnostics.length}`,
        ...result.diagnostics.map((diagnostic) => `  - ${diagnostic.message}`),
        'Scoped to the command handler itself and the CLI story-evidence writers, it writes no RED-evidence record, chain record or story/evidence artifact, emits no process event, changes no gate verdict, and runs no preCommand or postCommand hook. Nothing outside that scope is covered: see the red_evidence_envelope_check note in cli/activity-policy.ts, which lists the surfaces known when it was written and is not a proof of exhaustiveness. Fix the envelope before spending a run.',
        'That scope covers this command only, and by the time you read this line it may already have been overtaken: this report is THROWN, and cli-engine.ts prints it TWICE on this path — once as a failure diagnostic BEFORE any CONFIGURED and MATCHING onError hook runs, and once again AFTER those hooks have been awaited — so the copy in front of you may or may not postdate them. MATCHING means the hooks map carries an exact red_evidence_envelope_check key or a * key; a map with neither runs no command at all. Such a hook is arbitrary /bin/sh -c, so it can already have written evidence, appended a process event or moved a gate verdict. The CLI may also record this text in the error field of a .proof-or-stop/activity.jsonl row.',
      ].join('\n');
      throw new Error(args.json ? JSON.stringify(report, null, 2) : text);
    },

    red_evidence_quarantine(args: {
      storyId: string;
      recordId: string;
      reason: string;
      agent?: string;
      actor?: string;
      approvedBy?: string; // caller value is REJECTED (§4.1) — approvedBy is DERIVED.
    }): string {
      return appendChainControl(ctx, {
        command: 'red_evidence_quarantine',
        operation: 'quarantine',
        linkKind: 'quarantines',
        requiredHeadOperations: ['red-assert', 'green-confirm', 'recover'],
        args,
      });
    },

    red_evidence_recover(args: {
      storyId: string;
      recordId: string;
      reason: string;
      agent?: string;
      actor?: string;
      approvedBy?: string; // caller value is REJECTED (§4.1) — approvedBy is DERIVED.
    }): string {
      return appendChainControl(ctx, {
        command: 'red_evidence_recover',
        operation: 'recover',
        linkKind: 'recovers',
        requiredHeadOperations: ['quarantine'],
        args,
      });
    },
  };
}

interface ChainControlDispatch {
  command: 'red_evidence_quarantine' | 'red_evidence_recover';
  operation: 'quarantine' | 'recover';
  linkKind: 'quarantines' | 'recovers';
  requiredHeadOperations: readonly ('red-assert' | 'green-confirm' | 'quarantine' | 'recover')[];
  args: { storyId: string; recordId: string; reason: string; agent?: string; actor?: string; approvedBy?: string };
}

function appendChainControl(ctx: HandlerContext, dispatch: ChainControlDispatch): string {
  const { store, root } = ctx;
  const { command, operation, linkKind, requiredHeadOperations, args } = dispatch;

  // Actor mutation authority (owner LEASE is enforced upstream at the CLI choke
  // point; this is the independent role-authority gate). approvedBy is DERIVED
  // from this resolved actor + the session id — never a caller argument.
  const authority = resolveAgentMutationAuthority({
    command,
    payloadActors: [args.agent, args.actor],
  });

  const recordId = String(args.recordId ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  if (!recordId || !reason) {
    throw new Error(`${command}: recordId and reason must each be non-blank strings`);
  }

  // F-010 (§4.1): approvedBy is DERIVED as <actor>@<sessionId>; a free-form
  // caller-supplied approvedBy "is not accepted". REJECT it (fail-closed) rather
  // than silently ignoring it, so the unforgeable derivation is explicit at the
  // registered surface — a caller cannot pass a value under the impression it is
  // recorded.
  if (args.approvedBy !== undefined) {
    throw new Error(
      `${command}: approvedBy is derived as <actor>@<sessionId>, not a caller argument (§4.1) — ` +
        `remove the approvedBy field; nothing written.`,
    );
  }

  try {
    store.readStory(args.storyId);
  } catch {
    throw new Error(`Story ${args.storyId} not found`);
  }

  // Derive the target + referenced digest from the referenced record's chain —
  // never a caller argument. (Immutable records, so this pre-lock read is safe;
  // head-ness is re-validated under the lock inside appendControlRecord.)
  const referenced = findV2Record(store, args.storyId, recordId);
  const acceptanceTargetRef = referenced.acceptanceTargetRef;
  const referencedRecordDigest = referenced.recordDigest;

  // CHK-012 §3.3 write-time membership gate on the DERIVED target.
  assertTargetInExpected(store, args.storyId, acceptanceTargetRef, command);

  const operationKey = controlOperationKey({
    operation,
    storyId: args.storyId,
    acceptanceTargetRef,
    recoversRecordId: recordId,
    referencedRecordDigest,
    reason,
  });
  const approvedBy = deriveApprovedBy(authority.actor);

  const result: AppendResult = appendControlRecord({
    store,
    storyId: args.storyId,
    acceptanceTargetRef,
    operation,
    operationKey,
    recoversRecordId: recordId,
    referencedRecordDigest,
    linkKind,
    reason,
    approvedBy,
    requiredHeadOperations,
  });

  const commitHint = result.replayed ? '' : autoCommitStoryMetadata(root, args.storyId, command);
  const verb = operation === 'quarantine' ? 'Quarantined' : 'Recovered';
  const replayNote = result.replayed ? ' (replay — existing record returned, nothing written)' : '';
  return (
    `${verb} ${acceptanceTargetRef}: ${result.record.id} seq=${result.record.seq} ` +
    `references=${recordId} approvedBy=${approvedBy}${replayNote}${commitHint}`
  );
}
