






import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { processFactRegistryMap } from './registry-parser.mjs';
import { assert, processFactRegistryPath, read } from './support.mjs';
import { parseSourceFile, findFunctionDeclaration, collectConditionalObjectSpreads, isDefinedCheckOnMember, objectLiteralPropertyInitializer, isEmptyObjectLiteral, findCallExpressionByName, isIdentifierEqualsStringLiteral, subtreeReadsMember, subtreeAssignsIdentifierString, subtreeHasMemberEqualsString, hasIdentifierGuardedThrowingBranch, collectMemberCalls, collectCallExpressionsByName, findIfStatement, findMemberAssignment, subtreeComparesMembers, subtreeDeletesMember, findNewExpressionByName, findFunctionLike, objectLiteralHasProperty } from './source-analysis.mjs';

export function assertPhaseTransitionReopenAuditContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  assert(phaseTransitionFact?.level === 'L4', `${processFactRegistryPath}: phase transition convergence fact must remain L4`);
  assert(phaseTransitionFact?.producer === 'handlers/transition-orchestrator', `${processFactRegistryPath}: phase transition fact must identify the transition-orchestrator producer that emits the reopen audit fields`);
  for (const token of [
    'PLAN->INIT',
    'transitionType: "reopen"',
    'reason',
    'REOPEN_REASON_MIN',
    'append-only',
    'ONLY on a REOPEN',
    'omit',
    'not gate evidence',
    // B-70a6 F-004 recovery semantics — the guidance half of the dual-layer
    // contract for the crash window between the phase write and this append.
    'pendingReopenAudit',
    'reopenAuditId',
    'SAME atomic writeStory rename',
    'reconcilePendingReopenAudit',
    'idempotent',
    'exactly once',
    'without appending',
    'neither record nor event',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the reopen audit semantics token ${token}`);
  }

  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorSf = parseSourceFile(orchestratorPath);

  // (1) BUILDER: both audit fields are emitted only when the caller supplies
  // them, and the else branch stays `{}` — an explicit `field: undefined` would
  // add a key and change every ordinary transition's event shape.
  const builderFn = findFunctionDeclaration(orchestratorSf, 'buildPhaseTransitionProcessEvent');
  assert(builderFn?.body, `${orchestratorPath}: buildPhaseTransitionProcessEvent declaration must exist`);
  const builderSpreads = builderFn?.body ? collectConditionalObjectSpreads(builderFn.body) : [];
  for (const field of ['transitionType', 'reason', 'reopenAuditId']) {
    const spread = builderSpreads.find(item => isDefinedCheckOnMember(item.condition, 'input', field));
    assert(spread, `${orchestratorPath}: buildPhaseTransitionProcessEvent must emit ${field} only through a real \`input.${field} !== undefined\` conditional spread (an unconditional property, or a comment, cannot satisfy this)`);
    assert(spread && objectLiteralPropertyInitializer(spread.whenTrue, field), `${orchestratorPath}: buildPhaseTransitionProcessEvent must actually set ${field} in the supplied branch of its conditional spread`);
    assert(spread && isEmptyObjectLiteral(spread.whenFalse), `${orchestratorPath}: buildPhaseTransitionProcessEvent must OMIT ${field} entirely when the caller passes none (the else branch must stay {}; an explicit \`${field}: undefined\` key would change the ordinary transition event shape)`);
  }

  // (2) CALL SITE: a successful REOPEN emits BOTH fields; every ordinary
  // transition emits NEITHER. Only the call-site gate decides that — the builder
  // above emits whatever it is handed.
  const transitionFn = findFunctionDeclaration(orchestratorSf, 'runStoryTransitionInner');
  assert(transitionFn?.body, `${orchestratorPath}: runStoryTransitionInner declaration must exist`);
  const builderCall = transitionFn?.body ? findCallExpressionByName(transitionFn.body, 'buildPhaseTransitionProcessEvent') : undefined;
  assert(builderCall, `${orchestratorPath}: runStoryTransitionInner must append the phase_transition event through buildPhaseTransitionProcessEvent`);
  const callSpreads = builderCall?.arguments?.[0] ? collectConditionalObjectSpreads(builderCall.arguments[0]) : [];
  const reopenSpread = callSpreads.find(item => isIdentifierEqualsStringLiteral(item.condition, 'eventType', 'REOPEN'));
  assert(reopenSpread, `${orchestratorPath}: the phase_transition call site must gate the reopen audit fields on a real \`eventType === 'REOPEN'\` condition — without that gate either every ordinary transition carries the reopen marker or no reopen does`);
  const markerInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'transitionType') : undefined;
  assert(markerInit && ts.isStringLiteralLike(markerInit) && markerInit.text === 'reopen', `${orchestratorPath}: a successful REOPEN must emit the exact marker transitionType: 'reopen' in its phase_transition event`);
  const reasonInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'reason') : undefined;
  assert(reasonInit && subtreeReadsMember(reasonInit, 'args', 'reason'), `${orchestratorPath}: a successful REOPEN must persist the validated args.reason next to the marker (a validated-but-dropped reason is not durably auditable)`);
  const auditIdInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'reopenAuditId') : undefined;
  assert(auditIdInit && subtreeReadsMember(auditIdInit, 'reopenAudit', 'auditId'), `${orchestratorPath}: a successful REOPEN must stamp its recovery record's auditId onto the event (without that key, recovery cannot tell "my event is already on disk" from "it is missing" and can double-emit)`);
  assert(reopenSpread && isEmptyObjectLiteral(reopenSpread.whenFalse), `${orchestratorPath}: an ordinary transition must omit ALL reopen audit fields (the non-REOPEN branch of the call-site spread must stay {})`);

  // (3) The persisted reason is the VALIDATED one: the PLAN->INIT remap that
  // mints eventType='REOPEN' must still reject a missing/too-short reason before
  // the REOPEN event can be sent, so no under-length reason can reach the event.
  let reopenRemap;
  const findRemap = (n) => {
    if (reopenRemap) return;
    if (ts.isIfStatement(n) && subtreeAssignsIdentifierString(n.thenStatement, 'eventType', 'REOPEN')) { reopenRemap = n; return; }
    ts.forEachChild(n, findRemap);
  };
  if (transitionFn?.body) findRemap(transitionFn.body);
  assert(reopenRemap, `${orchestratorPath}: the gated PLAN->INIT reopen remap (a real \`eventType = 'REOPEN'\` assignment) must exist`);
  assert(reopenRemap && subtreeHasMemberEqualsString(reopenRemap.expression, 'phase', 'INIT') && subtreeHasMemberEqualsString(reopenRemap.expression, 'phase', 'PLAN'), `${orchestratorPath}: the REOPEN remap must stay bound to the PLAN->INIT shape (args.phase === 'INIT' && story.phase === 'PLAN')`);
  assert(reopenRemap && hasIdentifierGuardedThrowingBranch(reopenRemap.thenStatement, 'REOPEN_REASON_MIN'), `${orchestratorPath}: the REOPEN remap must keep the reason requirement fail-closed (an if-condition referencing REOPEN_REASON_MIN whose then-branch throws) so the reason persisted into the audit event is the validated one`);

  // ── B-70a6 F-004: the audit event must survive a crash between the phase
  // write and the append. The event is appended AFTER (and outside) the persist
  // claim, so that window is real; because REOPEN only fires FROM PLAN, a lost
  // event used to be UNRECOVERABLE. Checks (5)-(7) pin the recovery design:
  // ATOMIC record, ordered reconciliation, exact-identity idempotency.

  // (5) ATOMICITY: the recovery record must ride the SAME single writeStory
  // (tmp-write + renameSync) that persists phase=INIT. A record written by its
  // own second write would simply re-open the same crash window.
  const persistWrites = transitionFn?.body ? collectMemberCalls(transitionFn.body, 'store', 'writeStory') : [];
  assert(persistWrites.length === 1, `${orchestratorPath}: runStoryTransitionInner must keep EXACTLY ONE store.writeStory (the single atomic rename the reopen recovery record rides); found ${persistWrites.length}`);
  const phaseWrite = persistWrites[0];
  assert(phaseWrite && phaseWrite.arguments.length === 2 && ts.isIdentifier(phaseWrite.arguments[1]) && phaseWrite.arguments[1].text === 'story', `${orchestratorPath}: the phase write must persist the same \`story\` object the reopen recovery record is attached to`);
  const inventoryConsumes = transitionFn?.body ? collectCallExpressionsByName(transitionFn.body, 'consumeReviewInventoryReceipt') : [];
  assert(inventoryConsumes.length === 1 && phaseWrite && inventoryConsumes[0].end < phaseWrite.end,
    `${orchestratorPath}: REVIEW inventory receipt must be consumed exactly once BEFORE store.writeStory publishes phase=DEV`);
  const reopenRecordBranch = transitionFn?.body
    ? findIfStatement(transitionFn.body, (n) => isIdentifierEqualsStringLiteral(n.expression, 'eventType', 'REOPEN')
        && Boolean(findMemberAssignment(n.thenStatement, 'story', 'pendingReopenAudit')))
    : undefined;
  assert(reopenRecordBranch, `${orchestratorPath}: a REOPEN must attach its durable recovery record via a real \`story.pendingReopenAudit = ...\` assignment under a real \`eventType === 'REOPEN'\` branch — without it a crash before the append leaves an unaudited, unrecoverable reopen`);
  const recordAssignment = reopenRecordBranch ? findMemberAssignment(reopenRecordBranch.thenStatement, 'story', 'pendingReopenAudit') : undefined;
  assert(recordAssignment && phaseWrite && recordAssignment.end < phaseWrite.end, `${orchestratorPath}: the recovery record must be attached BEFORE the phase write so both land in the SAME atomic rename (attaching it afterwards persists nothing)`);
  assert(reopenRecordBranch && collectMemberCalls(reopenRecordBranch.thenStatement, 'store', 'writeStory').length === 0, `${orchestratorPath}: the recovery record must NOT be persisted by a write of its own — a second writeStory re-opens exactly the crash window this record closes`);

  // (6) ORDERED RECONCILIATION: a transition heals a crash-interrupted reopen
  // BEFORE it touches its own state, and retires the record only AFTER the event
  // is durable. That ordering is the guarantee AT THIS CALL SITE: no ORCHESTRATED
  // phase change can follow an unaudited reopen, and no record is dropped before
  // its event exists. Out-of-band writers get only the narrower, unserialized
  // version of it — see assertReopenAuditConcurrencyResidualContract.
  const reconcileCalls = transitionFn?.body ? collectCallExpressionsByName(transitionFn.body, 'reconcilePendingReopenAudit') : [];
  assert(reconcileCalls.length >= 2, `${orchestratorPath}: runStoryTransitionInner must both RECOVER an interrupted reopen at entry and RETIRE its own record after the append (found ${reconcileCalls.length} reconcilePendingReopenAudit call sites)`);
  const transitionAppends = transitionFn?.body ? collectMemberCalls(transitionFn.body, 'store', 'appendProcessEvent') : [];
  assert(transitionAppends.length === 1, `${orchestratorPath}: runStoryTransitionInner must keep exactly one phase_transition append site; found ${transitionAppends.length}`);
  assert(reconcileCalls.length > 0 && phaseWrite && reconcileCalls[0].end < phaseWrite.end, `${orchestratorPath}: the entry reconciliation must run BEFORE this transition's own phase write, so no ORCHESTRATED transition can advance a story while an unaudited reopen is still pending`);
  assert(reconcileCalls.length > 0 && transitionAppends.length > 0 && reconcileCalls[reconcileCalls.length - 1].end > transitionAppends[0].end, `${orchestratorPath}: the recovery record must be retired only AFTER its audit event has been appended (clearing it first re-opens the unrecoverable window)`);

  // (7) THE RECOVERY ITSELF: emits the missing event from the RECORD, guarded by
  // an exact reopenAuditId identity match, and clears only afterwards.
  const reconcileFn = findFunctionDeclaration(orchestratorSf, 'reconcilePendingReopenAudit');
  assert(reconcileFn?.body, `${orchestratorPath}: reconcilePendingReopenAudit declaration must exist (the recovery half of the durable-audit guarantee)`);
  const recoveryBuilderCall = reconcileFn?.body ? findCallExpressionByName(reconcileFn.body, 'buildPhaseTransitionProcessEvent') : undefined;
  assert(recoveryBuilderCall, `${orchestratorPath}: recovery must rebuild the missing event through the SAME buildPhaseTransitionProcessEvent builder as the in-line append`);
  const recoveryArg = recoveryBuilderCall?.arguments?.[0];
  const recoveryMarker = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'transitionType') : undefined;
  assert(recoveryMarker && ts.isStringLiteralLike(recoveryMarker) && recoveryMarker.text === 'reopen', `${orchestratorPath}: a recovered event must still carry the exact marker transitionType: 'reopen'`);
  const recoveryReason = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'reason') : undefined;
  assert(recoveryReason && subtreeReadsMember(recoveryReason, 'pending', 'reason'), `${orchestratorPath}: a recovered event must carry the reason from the RECORD (recomputing or omitting it loses the verbatim operator reason the reopen was gated on)`);
  const recoveryAuditId = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'reopenAuditId') : undefined;
  assert(recoveryAuditId && subtreeReadsMember(recoveryAuditId, 'pending', 'auditId'), `${orchestratorPath}: a recovered event must carry the record's auditId so a repeated recovery is a no-op instead of a second event`);
  assert(reconcileFn?.body && subtreeComparesMembers(reconcileFn.body, 'reopenAuditId', 'pending', 'auditId'), `${orchestratorPath}: "already audited" must be an EXACT reopenAuditId identity match against the record — matching on reason text would mis-handle two reopens sharing a reason and could swallow the second audit event`);
  const recoveryAppends = reconcileFn?.body ? collectMemberCalls(reconcileFn.body, 'store', 'appendProcessEvent') : [];
  assert(recoveryAppends.length === 1, `${orchestratorPath}: reconcilePendingReopenAudit must have exactly one append site; found ${recoveryAppends.length}`);
  const guardedRecoveryAppend = reconcileFn?.body
    ? findIfStatement(reconcileFn.body, (n) => collectMemberCalls(n.thenStatement, 'store', 'appendProcessEvent').length === 1)
    : undefined;
  assert(guardedRecoveryAppend, `${orchestratorPath}: the recovery append must be GUARDED by the already-audited check — an unconditional append would emit a second audit event every time reconciliation runs`);
  assert(guardedRecoveryAppend && ts.isPrefixUnaryExpression(guardedRecoveryAppend.expression) && guardedRecoveryAppend.expression.operator === ts.SyntaxKind.ExclamationToken, `${orchestratorPath}: the recovery append must be guarded by a NEGATED already-audited condition (append only when no matching event exists)`);
  assert(reconcileFn?.body && subtreeDeletesMember(reconcileFn.body, 'pendingReopenAudit'), `${orchestratorPath}: reconciliation must actually clear the recovery record (a record that is never cleared makes every later transition re-scan and never converges)`);
  const recoveryWrites = reconcileFn?.body ? collectMemberCalls(reconcileFn.body, 'store', 'writeStory') : [];
  assert(recoveryWrites.length === 1 && recoveryAppends.length === 1 && recoveryWrites[0].end > recoveryAppends[0].end, `${orchestratorPath}: the recovery record must be cleared only AFTER its event is durably appended — clearing first would lose the reason if the append then failed`);

  // (8) Executable coverage anchors for the same facts, so the structural checks
  // above are not the only proof: flow-stability-smoke (routine npm test) pins
  // the ordinary builder output shape by deepEqual, and the reopen roundtrip
  // smoke asserts key presence/absence on REAL persisted events plus the
  // fault-injected crash-window recovery end to end.
  const flowStabilityText = read('packages/main/src/tasks/flow-stability/done-convergence.ts');
  assert(/assert\.deepEqual\(buildPhaseTransitionProcessEvent\(/.test(flowStabilityText) && !/transitionType/.test(flowStabilityText), 'packages/main/src/tasks/flow-stability-smoke.ts: the ordinary phase_transition builder shape must stay pinned by deepEqual with NO reopen audit keys');
  const reopenSmokeText = read('packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts');
  for (const token of [
    "assert.equal(reopenEvent.transitionType, 'reopen'",
    'assert.equal(reopenEvent.reason, REOPEN_REASON',
    "hasOwnProperty.call(normalEvent, 'transitionType'), false",
    "hasOwnProperty.call(normalEvent, 'reason'), false",
    // B-70a6 F-004: the crash window is proven by fault injection into the real
    // path, not by hand-written fixture state. B-70a6 F-010 folded the F-004
    // drill's own copy of that injection into the SHARED crashInjectReopen helper,
    // so the same guarantee is now pinned across the two halves: the drill must
    // inject the crash WITH ITS OWN REASON through the helper, and the helper must
    // drive the REAL orchestrator and check the record carries that reason verbatim.
    'class CrashBeforeReopenAuditStore extends StoryStore',
    'await crashInjectReopen(wt, storyId, CRASH_REOPEN_REASON)',
    'await runStoryTransition(ctx, { storyId, phase: \'INIT\', reason })',
    'assert.ok(pending,',
    'assert.equal(pending!.reason, reason',
    "assert.equal(pending.fromPhase, 'PLAN'",
    'assert.equal(recovered.length, 1',
    'assert.equal(recovered[0].reason, CRASH_REOPEN_REASON',
    'assert.equal(recovered[0].reopenAuditId, pending.auditId',
  ]) {
    assert(reopenSmokeText.includes(token), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: end-to-end reopen audit assertion missing ${token}`);
  }
  assert(/assertReopenAuditCrashRecovery\(\)/.test(reopenSmokeText) && /^await assertReopenAuditCrashRecovery\(\);$/m.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the crash-window recovery drill must actually RUN (a defined-but-uncalled test proves nothing)');
  // B-70a6 F-010: ONE crash-injection implementation, not two. Every drill goes
  // through crashInjectReopen, so a change to how the crash is injected cannot be
  // applied to one copy and silently missed on the other.
  const crashInjectionSites = reopenSmokeText.split('new CrashBeforeReopenAuditStore(').length - 1;
  assert(crashInjectionSites === 1, `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the reopen crash injection must have exactly ONE implementation (the shared crashInjectReopen helper); found ${crashInjectionSites} \`new CrashBeforeReopenAuditStore(\` sites — a second copy is free to drift from the first`);
}

export function assertOutOfBandReopenAuditRescueContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  for (const token of [
    'OUT-OF-BAND PHASE MUTATIONS',
    'story_discard',
    'story_reconcile',
    'reconcileReopenAuditBeforeOutOfBandPhaseChange',
    'BEFORE their destructive steps',
    'DOOMED copy',
    'SURVIVING store',
    'never blocks',
    'DUPLICATE event sharing one auditId',
    '--purge',
    // B-70a6 F-008: the "surfaced, never swallowed" half of that promise, and its
    // ONE deliberate exception, are declared — not left to the code to imply.
    'no-op rather than a failure',
    // B-70a6 F-012: the purge claim stays at the precision that was actually
    // verified (the rescued event does not survive; the directory may).
    'predates the rescue',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the out-of-band rescue semantics token ${token}`);
  }

  // (1) THE RESCUE ITSELF: it must delegate to the one reconciliation function,
  // never grow an append site of its own (two append sites = two idempotency
  // rules that can drift), and must not throw the caller's operation away.
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorSf = parseSourceFile(orchestratorPath);
  const rescueFn = findFunctionDeclaration(orchestratorSf, 'reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueFn?.body, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist — it is what extends the "no unaudited reopen" invariant to phase writes that bypass the orchestrator, at the SEQUENTIAL strength documented on it (see assertReopenAuditConcurrencyResidualContract)`);
  const rescueDelegations = rescueFn?.body ? collectCallExpressionsByName(rescueFn.body, 'reconcilePendingReopenAudit') : [];
  assert(rescueDelegations.length >= 2, `${orchestratorPath}: the out-of-band rescue must delegate to reconcilePendingReopenAudit for BOTH the surviving-store record and the doomed-copy record (found ${rescueDelegations.length} delegations)`);
  assert(rescueFn?.body && collectMemberCalls(rescueFn.body, 'store', 'appendProcessEvent').length === 0, `${orchestratorPath}: the out-of-band rescue must NOT append the audit event itself — a second append site would let its idempotency rule drift from reconcilePendingReopenAudit's`);
  const doomedRead = rescueFn?.body ? findNewExpressionByName(rescueFn.body, 'StoryStore') : undefined;
  assert(doomedRead, `${orchestratorPath}: the rescue must open the DOOMED copy's own store (\`new StoryStore(recordRoot)\`) — story_discard's runtime root is redirected to the MAIN root, so without this it can never SEE the record it is supposed to save`);
  const rescueDoomedDelegation = rescueDelegations[rescueDelegations.length - 1];
  assert(rescueDoomedDelegation && rescueDoomedDelegation.arguments.length === 3, `${orchestratorPath}: the doomed-copy delegation must pass the record READ from the doomed copy while appending to the SURVIVING store (reconcilePendingReopenAudit(store, storyId, doomed))`);

  // (1b) B-70a6 F-008: the rescue's contract is "never thrown, always SURFACED".
  // The doomed-copy read — the one most likely to hit a permission error or a
  // corrupted-but-present index.json — was a bare `catch { continue; }` that
  // silently reported "nothing to rescue" for a real failure, which is the same
  // operator-invisible loss the rescue exists to prevent. Every catch inside the
  // rescue must therefore BIND its error and reach a warnings.push; the deliberate
  // silence for a doomed copy that holds no metadata at all is allowed only as a
  // guarded branch INSIDE such a catch, never as a bare swallow.
  const rescueCatchClauses = [];
  const collectCatchClauses = (n) => {
    if (ts.isCatchClause(n)) rescueCatchClauses.push(n);
    ts.forEachChild(n, collectCatchClauses);
  };
  if (rescueFn?.body) collectCatchClauses(rescueFn.body);
  assert(rescueCatchClauses.length >= 2, `${orchestratorPath}: the out-of-band rescue must keep its failure handling for BOTH the surviving-index reconciliation and the doomed-copy read (found ${rescueCatchClauses.length} catch clauses)`);
  for (const clause of rescueCatchClauses) {
    assert(clause.variableDeclaration, `${orchestratorPath}: every catch in the out-of-band rescue must BIND its error — a bare \`catch {}\` cannot report what actually went wrong`);
    assert(collectMemberCalls(clause.block, 'warnings', 'push').length > 0, `${orchestratorPath}: every catch in the out-of-band rescue must push a warning for the caller to surface (a swallowed read failure is indistinguishable from "there was nothing to rescue", which is exactly the silent loss this rescue is about)`);
  }

  // (2) THE TWO CALL SITES: each must run the rescue BEFORE it destroys anything
  // and BEFORE its own phase write. Ordering IS the guarantee.
  const outOfBandSites = [
    {
      path: 'packages/main/src/handlers/worktree.ts',
      fn: 'story_discard',
      phase: 'DISCARDED',
      // Every call that can destroy the copy holding the record.
      destructive: ['worktreeRemoveWithRetry', 'removePathWithTimeout', 'rmSync', 'pruneWorktreeRegistry'],
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      fn: 'story_reconcile',
      phase: 'DONE',
      destructive: ['rmSync'],
    },
  ];
  for (const site of outOfBandSites) {
    const sf = parseSourceFile(site.path);
    const fnNode = findFunctionLike(sf, site.fn);
    assert(fnNode?.body, `${site.path}: ${site.fn} must exist (it is one of the two out-of-band story.phase writers)`);
    const rescueCalls = collectCallExpressionsByName(fnNode.body, 'reconcileReopenAuditBeforeOutOfBandPhaseChange');
    assert(rescueCalls.length === 1, `${site.path}: ${site.fn} must call reconcileReopenAuditBeforeOutOfBandPhaseChange exactly once before mutating story.phase; found ${rescueCalls.length}`);
    // `assert` ACCUMULATES failures here rather than throwing, so every check
    // below must survive a missing call site (otherwise a deleted rescue reports
    // a TypeError instead of the finding it is supposed to name).
    const rescueCall = rescueCalls[0];
    if (!rescueCall) continue;
    const rescueArg = rescueCall.arguments?.[0];
    assert(rescueArg && objectLiteralHasProperty(rescueArg, 'store'), `${site.path}: ${site.fn} must hand the rescue the SURVIVING store (that is where the audit event has to land)`);
    const recordRootsArg = rescueArg ? objectLiteralPropertyInitializer(rescueArg, 'recordRoots') : undefined;
    assert(recordRootsArg && ts.isArrayLiteralExpression(recordRootsArg) && recordRootsArg.elements.length > 0, `${site.path}: ${site.fn} must pass a non-empty recordRoots array (the doomed worktree copy) — dropping it silently reduces the rescue to a no-op for exactly the case the finding reproduced`);

    const phaseAssignment = findMemberAssignment(fnNode.body, 'story', 'phase');
    assert(phaseAssignment, `${site.path}: ${site.fn} must still contain the out-of-band \`story.phase = '${site.phase}'\` assignment this contract is about`);
    assert(Boolean(phaseAssignment) && rescueCall.end < phaseAssignment.pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE it writes the terminal phase — after it, the record is already unreachable and the reopen is unaudited forever`);
    const phaseWrites = collectMemberCalls(fnNode.body, 'store', 'writeStory');
    assert(phaseWrites.length > 0 && rescueCall.end < phaseWrites[0].pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE its own store.writeStory`);
    for (const destructive of site.destructive) {
      for (const call of collectCallExpressionsByName(fnNode.body, destructive)) {
        assert(rescueCall.end < call.pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE the destructive \`${destructive}\` call — that call can delete the only copy holding the record`);
      }
    }
    // The rescue must be SURFACED. A silent rescue repeats the finding's core
    // complaint (silent loss) in a nicer costume.
    assert(collectCallExpressionsByName(fnNode.body, 'renderOutOfBandReopenAuditNotice').length === 1, `${site.path}: ${site.fn} must surface the rescue to the operator through renderOutOfBandReopenAuditNotice`);
  }

  // (3) EXECUTABLE COVERAGE: the ordering checks above are structural, so the
  // end-to-end drills must exist AND run. Each destroys the record-holding copy
  // for real and then asserts the event survived in the surviving log.
  const reopenSmokeText = read('packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts');
  for (const token of [
    // F-005a: the reviewer's exact repro (force discard from inside the worktree).
    "runBoth(wt, 'story_discard', { storyId, force: true",
    'assert.equal(existsSync(wt), false',
    'assert.equal(survived[0].reopenAuditId, pending.auditId',
    // F-005b: the second out-of-band site.
    "runBoth(root, 'story_reconcile', { dryRun: false }",
    "assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE'",
    // F-006: idempotency by auditId identity is NOT idempotency by reason text.
    'const SHARED_REOPEN_REASON',
    'assert.equal(events.length, 2',
    'assert.equal(new Set(events.map(e => e.reopenAuditId)).size, 2',
  ]) {
    assert(reopenSmokeText.includes(token), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: out-of-band / same-reason drill assertion missing ${token}`);
  }
  for (const drill of [
    'assertReopenAuditSurvivesStoryDiscard',
    'assertReopenAuditSurvivesZombieReconcile',
    'assertSameReasonReopensAreAuditedSeparately',
  ]) {
    assert(new RegExp(`^await ${drill}\\(\\);$`, 'm').test(reopenSmokeText), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the ${drill} drill must actually RUN (a defined-but-uncalled test proves nothing)`);
  }
  // A discard/reconcile that a rescue could BLOCK would be a worse regression
  // than the audit loss, so both drills pin the success exit code too.
  assert(/assert\.equal\(discard\.code, 0/.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the discard drill must assert story_discard still SUCCEEDS (the rescue must never block a legitimate discard)');
  assert(/assert\.equal\(reconcile\.code, 0/.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the zombie drill must assert story_reconcile still SUCCEEDS (the rescue must never block a legitimate repair)');
}

export function assertReopenAuditConcurrencyResidualContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  for (const token of [
    'CONCURRENCY RESIDUAL (B-70a6 F-013)',
    // The mechanism, not just the word "residual": WHY it does not hold.
    'one-time scan that does not hold the per-story transition lock',
    'neither the record nor the event survives',
    // The narrowed claim itself, and the case it still covers.
    'SEQUENTIAL',
    'not covered',
    // The reasons it is named rather than locked. Each is independently
    // load-bearing: drop one and the decision reads as an excuse.
    'best-effort advisory contention reducer',
    'PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK',
    'invert the established transitionLock to mainWriteLock order',
    'follow-up story and is not claimed here',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the F-013 concurrency residual token ${token} — a rescue documented as stronger than it is is exactly the overclaim this story was bitten by`);
  }

  // The residual must ALSO be where a reader of the CODE meets it: on the rescue
  // itself, at both call sites that depend on it, on the record type, and in the
  // drill header that would otherwise read as proof of a concurrency guarantee.
  const residualMarker = 'CONCURRENCY RESIDUAL (B-70a6 F-013)';
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const residualSites = [
    {
      path: orchestratorPath,
      tokens: [
        residualMarker,
        // The defect in one phrase, plus the two escape hatches that make the
        // lock unusable as a correctness fence.
        'SERIALIZES AGAINST NOTHING',
        'NEITHER the record NOR the event survives',
        'BEST-EFFORT ADVISORY CONTENTION-REDUCER',
        'PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK',
        'FOLLOW-UP STORY',
      ],
    },
    {
      path: 'packages/main/src/handlers/worktree.ts',
      tokens: [residualMarker, 'ONE-TIME SCAN', 'neither record nor event survives'],
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      // The reconcile site carries the ordering reason specifically: it is the
      // one whose lock acquisition would deadlock against the main write lock.
      tokens: [residualMarker, 'ONE-TIME SCAN', 'invert that order'],
    },
    {
      path: 'packages/main/src/core/types.ts',
      tokens: [residualMarker, 'NOT a concurrency guarantee'],
    },
    {
      path: 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts',
      // The drills are sequential by construction; saying so stops a later reader
      // from citing them as evidence for the race they never exercise.
      tokens: [residualMarker, 'SEQUENTIAL', 'do NOT prove'],
    },
  ];
  for (const site of residualSites) {
    const text = read(site.path);
    for (const token of site.tokens) {
      assert(text.includes(token), `${site.path}: must document the F-013 concurrency residual (missing ${JSON.stringify(token)}) — the out-of-band reopen-audit rescue is unserialized, and every site that leans on it has to say so`);
    }
  }

  // The residual on the rescue must sit ON the rescue's own docblock, not be
  // parked somewhere else in a 1500-line file where nobody editing it will see it.
  const orchestratorText = read(orchestratorPath);
  const rescueDecl = orchestratorText.indexOf('export function reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueDecl !== -1, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist`);
  // Anchored to the docblock that immediately precedes the declaration (the last
  // `/**` before it), not to a byte distance: the marker is deliberately
  // cross-referenced from reconcilePendingReopenAudit higher up, and an
  // earliest-occurrence match would be satisfied by that mention alone.
  const docblockStart = rescueDecl === -1 ? -1 : orchestratorText.lastIndexOf('/**', rescueDecl);
  const markerAt = rescueDecl === -1 ? -1 : orchestratorText.lastIndexOf(residualMarker, rescueDecl);
  assert(docblockStart !== -1 && markerAt > docblockStart && markerAt < rescueDecl, `${orchestratorPath}: the F-013 concurrency residual must be documented in the docblock immediately ABOVE reconcileReopenAuditBeforeOutOfBandPhaseChange (a residual filed far from the function it qualifies is one nobody reads before changing it)`);

  // THE RE-INFLATION GUARD. The unqualified invariant is the wording that was
  // false; it must not return. Comment markers are stripped and whitespace
  // collapsed first, so re-wrapping the sentence across lines does not evade it.
  const unqualifiedInvariant = /no phase change can follow an unaudited reopen/i;
  const claimSurfaces = [
    orchestratorPath,
    'packages/main/src/handlers/worktree.ts',
    'packages/main/src/handlers/story-query.ts',
    'packages/main/src/core/types.ts',
    'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts',
    processFactRegistryPath,
  ];
  for (const path of claimSurfaces) {
    const flattened = read(path).replace(/^\s*(?:\/\/|\*)\s?/gm, ' ').replace(/\s+/g, ' ');
    assert(!unqualifiedInvariant.test(flattened), `${path}: states the UNQUALIFIED invariant "no phase change can follow an unaudited reopen". That is false under a concurrent story_discard (B-70a6 F-013): the out-of-band rescue holds no transition lock, so a reopen that records AFTER its scan loses both record and event. Qualify it (e.g. "no ORCHESTRATED phase change ...") and keep the F-013 residual declared`);
  }
}

export function flattenComments(text) {
  return text.replace(/^\s*(?:\/\/|\*)\s?/gm, ' ').replace(/\s+/g, ' ');
}

export function assertReopenAuditLockRejectionRationaleContract() {
  const registry = processFactRegistryMap();
  const rationale = registry.get('runtime:closeout_phase_transition')?.rationale ?? '';
  for (const token of [
    // The correction is recorded, not quietly swapped in.
    'B-70a6 F-014 corrected the reason',
    'That argument was misdirected',
    // Reason 2, which REPLACED the misdirected one: story_discard is a recovery
    // command and the only exposed acquire shape blocks.
    'recovery command an operator reaches for',
    'exposes no fail-fast option',
    // The alternative that WAS available had to be answered, not ignored.
    'non-blocking try-acquire',
    // Reason 3 stays accurate only while it is scoped to the site it applies to.
    'specific to story_reconcile rather than to story_discard',
  ]) {
    assert(rationale.includes(token), `${processFactRegistryPath}: the phase transition rationale must declare the CORRECTED lock-rejection reason token ${JSON.stringify(token)} (B-70a6 F-014) — a residual declined for a misdirected reason is an overclaim about the decision itself`);
  }
  assert(!rationale.includes('because the authoritative persist claim is a fail-fast 15s claim'), `${processFactRegistryPath}: the phase transition rationale presents the transition-cas persist claim (staleMs 15000) as a REASON the out-of-band rescue is unlocked. B-70a6 F-014: that primitive was never the candidate — acquireStoryTransitionLock (staleMs 120000) is, and it is sized for exactly this kind of long synchronous section. State the reasons that hold`);

  // The same correction must be where a reader of the CODE meets the decision:
  // on the rescue's own docblock and at both call sites that lean on it.
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorText = read(orchestratorPath);
  const rescueDecl = orchestratorText.indexOf('export function reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueDecl !== -1, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist`);
  const rescueDocblock = rescueDecl === -1
    ? ''
    : flattenComments(orchestratorText.slice(orchestratorText.lastIndexOf('/**', rescueDecl), rescueDecl));
  for (const token of [
    'CORRECTED BY B-70a6 F-014',
    'RECOVERY COMMAND',
    // The available alternative had to be ANSWERED, not passed over. `try-acquire`
    // alone is too weak a token (it recurs in the paragraph, so deleting one
    // mention leaves it satisfied), hence the verdict phrase alongside it.
    'try-acquire',
    'was considered and DECLINED',
    'SITE-SPECIFIC',
  ]) {
    assert(rescueDocblock.includes(token), `${orchestratorPath}: the WHY IT IS NAMED RATHER THAN LOCKED docblock on reconcileReopenAuditBeforeOutOfBandPhaseChange must carry the B-70a6 F-014 correction token ${JSON.stringify(token)} — the decision is read HERE, so a stale reason here is the one that misleads`);
  }
  assert(!rescueDocblock.includes('The AUTHORITATIVE fence, the persist claim below'), `${orchestratorPath}: the rescue docblock again gives the transition-cas persist claim as the reason it is unlocked. B-70a6 F-014 retracted that argument: the persist claim was never the candidate primitive (acquireStoryTransitionLock is, and its staleMs is 120000)`);

  const siteTokens = [
    {
      path: 'packages/main/src/handlers/worktree.ts',
      tokens: ['CORRECTED BY B-70a6 F-014', 'RECOVERY COMMAND', 'was considered and declined'],
      // The exact retracted sentence, flattened, so a re-wrapped revert still bites.
      forbidden: 'the authoritative persist claim is a 15s fail-fast claim',
      forbiddenWhy: 'gives the transition-cas persist claim as the reason story_discard is unlocked (B-70a6 F-014 retracted it: that primitive was never the candidate)',
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      // The lock-order reason is TRUE here and FALSE at the discard site; the
      // comment has to say which, or it gets copied to the site it does not fit.
      tokens: ['SPECIFIC TO THIS SITE'],
      forbidden: null,
      forbiddenWhy: '',
    },
  ];
  for (const site of siteTokens) {
    const flattened = flattenComments(read(site.path));
    for (const token of site.tokens) {
      assert(flattened.includes(token), `${site.path}: must carry the B-70a6 F-014 lock-rejection correction token ${JSON.stringify(token)} — this call site states why it takes no transition lock, so it is a place the misdirected reason has to be corrected`);
    }
    if (site.forbidden) {
      assert(!flattened.includes(site.forbidden), `${site.path}: ${site.forbiddenWhy}`);
    }
  }

  // B-70a6 F-016: the PendingReopenAudit docblock's own recovery sentence must be
  // accurate on its own, not merely corrected by a paragraph appended after it. A
  // reader who stops at that sentence must not come away with the pre-F-005
  // "some later transition always heals it" impression.
  const typesPath = 'packages/main/src/core/types.ts';
  const typesFlattened = flattenComments(read(typesPath));
  assert(!/emits the missing event on the next transition/i.test(typesFlattened), `${typesPath}: the PendingReopenAudit docblock again says reconcilePendingReopenAudit "emits the missing event on the next transition", unqualified. B-70a6 F-005/F-013: recovery fires at the next ORCHESTRATED transition and at the two out-of-band sites, under no concurrency guarantee — qualify the sentence itself, not only a paragraph after it`);
  for (const token of [
    'ONLY at the points enumerated in the next paragraph',
    'EDITED IN PLACE',
  ]) {
    assert(typesFlattened.includes(token), `${typesPath}: the PendingReopenAudit recovery sentence must carry the B-70a6 F-016 in-place qualification token ${JSON.stringify(token)} (an appended qualifier alone leaves the sentence above it reading as an unconditional promise)`);
  }

  // B-70a6 F-017: the SAME retired wording, at the two IN-FUNCTION comment sites
  // the check above cannot see because it reads types.ts only. Both sat inside
  // runStoryTransitionInner still saying, unqualified, that "the next transition"
  // heals / performs the recovery — the identical over-claim about the identical
  // crash window, untouched by F-005/F-013/F-016 precisely because nothing
  // mechanised them. Recovery is ALSO performed out of band (story_discard, the
  // repairing story_reconcile) and is SEQUENTIAL only, so the unqualified sentence
  // promises more than the code delivers wherever it appears.
  const orchestratorFlattened = flattenComments(orchestratorText);
  for (const retired of [
    'is healed by reconcilePendingReopenAudit on the next transition',
    'the next transition performs the (identical) recovery',
  ]) {
    assert(!orchestratorFlattened.includes(retired), `${orchestratorPath}: the retired unqualified sentence ${JSON.stringify(retired)} is back (B-70a6 F-017). Recovery fires at the next ORCHESTRATED transition AND at the out-of-band rescue (story_discard, the repairing story_reconcile), and only SEQUENTIALLY — a reopen racing a concurrent terminal operation is not recovered at all`);
  }

  // Anchored to each comment's OWN statement, so the qualification has to live at
  // the site a maintainer actually reads, not somewhere else in a 1600-line file.
  const recoveryTimingSites = [
    {
      what: 'the reopen-audit record ATTACH comment (the write that makes a crashed reopen recoverable)',
      from: "// B-70a6 F-004: the gated PLAN->INIT reopen's DURABLE audit record.",
      to: 'let reopenAudit: PendingReopenAudit | undefined;',
    },
    {
      what: 'the reopen-audit record CLEAR comment (the in-line twin of the recovery path)',
      from: '// B-70a6 F-004: the reopen is now durably audited',
      to: 'if (reopenAudit) {',
    },
  ];
  for (const site of recoveryTimingSites) {
    const from = orchestratorText.indexOf(site.from);
    const to = from === -1 ? -1 : orchestratorText.indexOf(site.to, from);
    assert(from !== -1 && to > from, `${orchestratorPath}: could not locate ${site.what} (anchors ${JSON.stringify(site.from)} .. ${JSON.stringify(site.to)}). B-70a6 F-017 guards the recovery-timing wording there — if the code moved, move the anchors with it instead of dropping the guard`);
    if (from === -1 || to <= from) continue;
    // Comment markers stripped and whitespace collapsed FIRST: a raw `includes`
    // over the source walks straight through a comment that merely re-wraps the
    // sentence across two lines (an earlier round of this story hit exactly that).
    const slice = flattenComments(orchestratorText.slice(from, to));
    for (const token of [
      'next ORCHESTRATED transition',
      'reconcileReopenAuditBeforeOutOfBandPhaseChange',
      'story_discard',
      'RACING a concurrent terminal operation is not recovered',
    ]) {
      assert(slice.includes(token), `${orchestratorPath}: ${site.what} must carry the B-70a6 F-017 recovery-timing token ${JSON.stringify(token)} — recovery is not "on the next transition": it is the next ORCHESTRATED transition OR the out-of-band rescue at story_discard / the repairing story_reconcile, and the guarantee is SEQUENTIAL only`);
    }
    assert(!/\bthe next transition\b/i.test(slice), `${orchestratorPath}: ${site.what} again says "the next transition", unqualified (B-70a6 F-017). Write "the next ORCHESTRATED transition" and name the out-of-band rescue, so the sentence is true on its own rather than corrected by a paragraph elsewhere`);
  }
}
