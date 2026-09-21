import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';











import { classifyReviewerExecutionAuthority } from "../../core/managed-review-evidence.js";




import { collectReviewerEvidenceState } from "../../core/review-run.js";
import { signReviewPass } from "../../core/finding-verify.js";

import { generateEd25519KeyPair } from "../../core/authority-signing.js";
import {
  signNativeReviewInvocationAttestation,
  verifyNativeReviewInvocationAttestation,
} from "../../core/native-review-attestation.js";
import {
  classifyNativeHostProcessLineage,
  issueNativeReviewEvidenceBinding,
} from "../../core/native-review-evidence.js";



import type { Finding } from "../../core/types.js";




import { STORY_ID, LANE, REVIEW_RUN_ID, CLI, withoutManagedAmbientAuthority } from "./environment.js";
import { runBrokeredCli } from "./transport-workers.js";
import type { runPhase as previousPhase } from './evidence-binding.js';
export async function runPhase(context: NonNullable<Awaited<ReturnType<typeof previousPhase>>>) {

context.store.writeFindings(STORY_ID, { findings: [...context.findingsBeforeNativeBroker, context.nativeFinding] });

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.id === context.nativeFinding.id),
      'registered broker attestation authorizes a native finding when OS ancestry is unavailable',
    );

for (const [label, mutate] of [
      ['category', (value: Finding) => ({ ...value, category: 'adversarial' as const })],
      ['evidenceState', (value: Finding) => ({ ...value, evidenceState: 'suspected' as const, uncertaintyReason: 'controller rewrite' })],
      ['uncertaintyReason', (value: Finding) => ({ ...value, uncertaintyReason: 'unsigned controller text' })],
      ['files', (value: Finding) => ({ ...value, files: ['packages/main/src/forged.ts'] })],
      ['disprovenEvidence', (value: Finding) => ({ ...value, disprovenEvidence: { ...value.disprovenEvidence!, summary: 'unsigned controller rewrite' } })],
    ] as const) {
      const mutated = mutate(structuredClone(context.nativeFinding));
      context.store.writeFindings(STORY_ID, { findings: [...context.findingsBeforeNativeBroker, mutated] });
      assert.ok(
        collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => candidate.evidenceId === context.nativeFinding.id),
        `native finding signature binds immutable ${label} semantics`,
      );
    }

context.store.writeFindings(STORY_ID, { findings: context.findingsBeforeNativeBroker });

for (const [field, changed] of [
      ['storyId', 'B-other-story'],
      ['agent', 'proof-or-stop-review-concept'],
      ['lane', 'proof-or-stop-review-concept'],
      ['reviewRunId', `${STORY_ID}:RR-999`],
      ['writerSessionId', 'different-writer-session'],
      ['dispatchBindingDigest', `sha256:${'9'.repeat(64)}`],
    ] as const) {
      const swapped = signNativeReviewInvocationAttestation({
        ...context.invocationClaims,
        [field]: changed,
        invocationNonce: randomUUID(),
      }, context.brokerKeys.privateKey);
      const result = verifyNativeReviewInvocationAttestation({
        attestation: swapped,
        trustedBrokers: [{
          brokerId: 'smoke-codex-broker',
          adapterId: 'codex-desktop',
          host: 'codex',
          publicKey: context.brokerKeys.publicKey,
        }],
        expected: context.invocationClaims,
      });
      assert.equal(result.ok, false, `signed cross-${field} attestation cannot be replayed into this invocation`);
    }

const attackerKeys = generateEd25519KeyPair();

const selfMinted = signNativeReviewInvocationAttestation({
      ...context.invocationClaims,
      writerSessionId: 'raw-self-mint-session',
      invocationNonce: randomUUID(),
    }, attackerKeys.privateKey);

const selfMintedCli = await runBrokeredCli(context.root, 'review_pass_set', {
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'Raw provider self-mints a matching dispatch and ReviewRun attestation.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    }, selfMinted, {
      ...process.env,
      PROOF_OR_STOP_SESSION_ID: 'raw-self-mint-session',
      PROOF_OR_STOP_AGENT: LANE,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-provider-self-mint',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
    });

assert.notEqual(selfMintedCli.status, 0, 'raw provider cannot self-mint authority even when all dispatch and ReviewRun claims match');

assert.match(`${selfMintedCli.stdout}${selfMintedCli.stderr}`, /signature is invalid/);

const originalTerminalFixture = context.store.readReviewPasses(STORY_ID);

context.store.writeReviewPasses(STORY_ID, { passes: [] });

const seedRetrySession = 'seed-native-pass-retry';

const seedRetryAttestation = signNativeReviewInvocationAttestation({ ...context.invocationClaims,
      writerSessionId: seedRetrySession, invocationNonce: randomUUID(), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, context.brokerKeys.privateKey);

const seededRetry = await runBrokeredCli(context.root, 'review_pass_set', {
      storyId: STORY_ID, agent: LANE, reviewRunId: REVIEW_RUN_ID, note: 'Real native terminal for authenticated retry controls.',
      readManifest: { filesReadFully: ['packages/main/src/example.ts'], filesTriagedByName: [], scanEscalationReason: null },
    }, seedRetryAttestation, { ...process.env, PROOF_OR_STOP_SESSION_ID: seedRetrySession, PROOF_OR_STOP_AGENT: LANE,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: seedRetrySession,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE });

assert.equal(seededRetry.status, 0, `real native retry baseline: ${seededRetry.stderr}`);

const terminalBeforeForgedRetry = context.store.readReviewPasses(STORY_ID);

const existingTerminal = terminalBeforeForgedRetry.passes.find(pass => pass.reviewRunId === REVIEW_RUN_ID && pass.agent === LANE)!;

assert.ok(existingTerminal, 'forged retry control requires an existing terminal pass');

const samePayloadForgedRetry = await runBrokeredCli(context.root, 'review_pass_set', {
      storyId: STORY_ID, agent: LANE, reviewRunId: REVIEW_RUN_ID,
      note: existingTerminal.note, readManifest: existingTerminal.readManifest,
    }, selfMinted, {
      ...process.env, PROOF_OR_STOP_SESSION_ID: 'raw-self-mint-session', PROOF_OR_STOP_AGENT: LANE,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-provider-self-mint',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
    });

assert.notEqual(samePayloadForgedRetry.status, 0, 'semantic equality must not bypass native invocation authentication');

assert.match(`${samePayloadForgedRetry.stdout}${samePayloadForgedRetry.stderr}`, /signature is invalid/);

assert.deepEqual(context.store.readReviewPasses(STORY_ID), terminalBeforeForgedRetry, 'forged retries cannot mutate the terminal evidence');

const authorizedRetrySession = 'authorized-native-pass-retry';

const authorizedRetryEnv = {
      ...process.env, PROOF_OR_STOP_SESSION_ID: authorizedRetrySession, PROOF_OR_STOP_AGENT: LANE,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'authorized-native-pass-retry',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
    };

const authorizedRetry = signNativeReviewInvocationAttestation({
      ...context.invocationClaims, writerSessionId: authorizedRetrySession, invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, context.brokerKeys.privateKey);

const retryPayload = { storyId: STORY_ID, agent: LANE, reviewRunId: REVIEW_RUN_ID, note: existingTerminal.note, readManifest: existingTerminal.readManifest };

const authorizedRetryResult = await runBrokeredCli(context.root, 'review_pass_set', retryPayload, authorizedRetry, authorizedRetryEnv);

assert.equal(authorizedRetryResult.status, 0, `fresh authorized retry: ${authorizedRetryResult.stderr}`);

assert.match(authorizedRetryResult.stdout, /idempotent retry/);

assert.deepEqual(context.store.readReviewPasses(STORY_ID), terminalBeforeForgedRetry);

const consumedRetry = await runBrokeredCli(context.root, 'review_pass_set', retryPayload, authorizedRetry, authorizedRetryEnv);

assert.notEqual(consumedRetry.status, 0, 'a repeated attestation nonce cannot authorize an idempotent retry');

assert.match(`${consumedRetry.stdout}${consumedRetry.stderr}`, /nonce was already consumed/);

assert.deepEqual(context.store.readReviewPasses(STORY_ID), terminalBeforeForgedRetry);

context.store.writeReviewPasses(STORY_ID, originalTerminalFixture);

const inlineSession = 'inherited-inline-attestation-session';

const inlineAttestation = signNativeReviewInvocationAttestation({
      ...context.invocationClaims,
      writerSessionId: inlineSession,
      invocationNonce: randomUUID(),
    }, context.brokerKeys.privateKey);

const inheritedInline = spawnSync(process.execPath, [CLI, 'review_pass_set', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'An inherited inline environment token must not become native authority.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: context.root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: inlineSession,
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-inherited-inline-token',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        LATTICE_NATIVE_REVIEW_ATTESTATION: JSON.stringify(inlineAttestation),
      },
    });

assert.notEqual(inheritedInline.status, 0, 'inherited inline env token is not an accepted broker injection seam');

assert.match(`${inheritedInline.stdout}${inheritedInline.stderr}`, /requires a registered host-adapter invocation attestation/);

const mixedCodexClaims = signNativeReviewInvocationAttestation({
      ...context.invocationClaims,
      invocationNonce: randomUUID(),
    }, context.brokerKeys.privateKey);

assert.throws(() => issueNativeReviewEvidenceBinding({
      projectRoot: context.root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: context.invocationClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: context.nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: context.nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: context.nativeDispatch.dispatchBindingDigest,
      },
      attestation: mixedCodexClaims,
      observeProcess: () => classifyNativeHostProcessLineage([
        { pid: 303, ppid: 202, comm: 'codex', command: 'codex exec' },
        { pid: 202, ppid: 1, comm: 'claude', command: 'claude review' },
      ]),
    }), /mixed provider ancestry=codex->claude/, 'Claude to Codex mixed tree is rejected despite a valid nearest-host broker attestation');

const claudeBrokerKeys = generateEd25519KeyPair();

const claudeDispatch = {
      hostRenderHost: 'claude' as const,
      dispatchPromptDigest: `sha256:${'1'.repeat(64)}`,
      hostRenderIdentityDigest: `sha256:${'2'.repeat(64)}`,
      dispatchBindingDigest: `sha256:${'3'.repeat(64)}`,
    };

const claudeClaims = {
      ...context.invocationClaims,
      brokerId: 'smoke-claude-broker',
      adapterId: 'claude-code-hook',
      host: 'claude' as const,
      writerSessionId: 'native-claude-session',
      dispatchPromptDigest: claudeDispatch.dispatchPromptDigest,
      dispatchBindingDigest: claudeDispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: claudeDispatch.hostRenderIdentityDigest,
      invocationNonce: randomUUID(),
    };

assert.throws(() => issueNativeReviewEvidenceBinding({
      projectRoot: context.root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: claudeClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'claude-code',
        nativeSessionRef: 'claude-code:validated-composite',
      },
      dispatch: claudeDispatch,
      attestation: signNativeReviewInvocationAttestation(claudeClaims, claudeBrokerKeys.privateKey),
      trustedBrokers: [{
        brokerId: claudeClaims.brokerId,
        adapterId: claudeClaims.adapterId,
        host: 'claude',
        publicKey: claudeBrokerKeys.publicKey,
      }],
      observeProcess: () => classifyNativeHostProcessLineage([
        { pid: 404, ppid: 303, comm: 'claude', command: 'claude review' },
        { pid: 303, ppid: 1, comm: 'codex', command: 'codex exec' },
      ]),
    }), /mixed provider ancestry=claude->codex/, 'Codex to Claude mixed tree is rejected despite a valid nearest-host broker attestation');

assert.throws(
      () => issueNativeReviewEvidenceBinding({
        projectRoot: context.root,
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        identity: {
          sessionId: context.nativePass.writerSessionId!,
          sessionSource: 'host-adapter',
          hostProvider: 'codex',
          nativeSessionRef: 'codex:validated-composite',
        },
        dispatch: {
          hostRenderHost: 'codex',
          dispatchPromptDigest: context.nativeDispatch.dispatchPromptDigest,
          hostRenderIdentityDigest: context.nativeDispatch.hostRenderIdentityDigest,
          dispatchBindingDigest: context.nativeDispatch.dispatchBindingDigest,
        },
        attestation: context.brokerAttestation,
        observeProcess: () => null,
      }),
      /already consumed/,
      'broker invocation attestation is one-shot even when every context field still matches',
    );

const inheritedClaims = {
      ...context.invocationClaims,
      writerSessionId: 'inherited-codex-env',
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

assert.throws(
      () => issueNativeReviewEvidenceBinding({
        projectRoot: context.root,
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        identity: {
          sessionId: 'inherited-codex-env',
          sessionSource: 'host-adapter',
          hostProvider: 'codex',
          nativeSessionRef: 'codex:validated-composite',
        },
        dispatch: {
          hostRenderHost: 'codex',
          dispatchPromptDigest: context.nativeDispatch.dispatchPromptDigest,
          hostRenderIdentityDigest: context.nativeDispatch.hostRenderIdentityDigest,
          dispatchBindingDigest: context.nativeDispatch.dispatchBindingDigest,
        },
        attestation: signNativeReviewInvocationAttestation(inheritedClaims, context.brokerKeys.privateKey),
        observeProcess: () => ({ host: 'claude', processLineageDigest: `sha256:${'b'.repeat(64)}` }),
      }),
      /nearest provider process=claude/,
      'inherited or forged Codex environment cannot hide that the nearest real provider process is Claude',
    );

const passesBeforeRawCli = context.store.readReviewPasses(STORY_ID).passes.length;

const rawCli = spawnSync(process.execPath, [CLI, 'review_pass_set', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'Raw Claude CLI attempts to write a direct pass against a Codex-native dispatch.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: context.root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: 'raw-cross-provider-reviewer',
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-claude-review',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        CLAUDE_CODE_SESSION_ID: 'raw-claude-review',
      },
    });

assert.notEqual(rawCli.status, 0, 'real raw cross-provider CLI review_pass_set must fail');

assert.match(
      `${rawCli.stdout}${rawCli.stderr}`,
      /cross-provider direct reviewer evidence is advisory-only|requires a registered host-adapter invocation attestation/,
      'real raw CLI is rejected by the same production native-host authority boundary',
    );

assert.equal(
      context.store.readReviewPasses(STORY_ID).passes.length,
      passesBeforeRawCli,
      'rejected raw cross-provider CLI creates no formal pass artifact',
    );

const findingsBeforeRawCli = context.store.readFindings(STORY_ID).findings.length;

const rawCliFinding = spawnSync(process.execPath, [CLI, 'finding_add', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      desc: 'raw cross-provider CLI cannot mint a formal finding',
      severity: 'high',
      category: 'adversarial',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: context.root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: 'raw-cross-provider-reviewer',
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-claude-review',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        CLAUDE_CODE_SESSION_ID: 'raw-claude-review',
      },
    });

assert.notEqual(rawCliFinding.status, 0, 'real raw cross-provider CLI finding_add must fail');

assert.match(`${rawCliFinding.stdout}${rawCliFinding.stderr}`, /cross-provider direct reviewer evidence is advisory-only|requires a live Codex\/Claude process ancestor/);

assert.equal(
      context.store.readFindings(STORY_ID).findings.length,
      findingsBeforeRawCli,
      'rejected raw cross-provider CLI creates no formal finding artifact',
    );

assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'native-host',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'native-host-signed-review',
      directSignedReviewAllowed: true,
      managedReceiptRequired: false,
      reviewGatePath: 'direct-signed-review',
    });

assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'native-host',
      assuranceLevel: 'degraded-single-host',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'degraded-single-host-local-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: false,
      reviewGatePath: 'local-host-verdict-only',
    }, 'explicit degraded fallback stays local assurance and cannot masquerade as native or managed REVIEW evidence');

const degradedPass = structuredClone(context.originalPass);

delete degradedPass.managedEvidenceBinding;

delete degradedPass.nativeEvidenceBinding;

degradedPass.writerSessionId = 'degraded-single-host-local-control';

degradedPass.sessionSource = 'review-escalation-degraded-single-host';

degradedPass._hash = signReviewPass(
      STORY_ID,
      degradedPass.id,
      degradedPass.agent,
      degradedPass.note,
      degradedPass.createdAt,
      degradedPass.reviewRound ?? '',
      degradedPass.reviewRunId ?? '',
      degradedPass.readManifest,
      degradedPass.readLog,
      degradedPass.readDiagnostics,
      { writerSessionId: degradedPass.writerSessionId, sessionSource: degradedPass.sessionSource },
      degradedPass.envelopeId,
    );

return Object.defineProperties(context, {
  attackerKeys: { enumerable: true, get: () => attackerKeys },
  selfMinted: { enumerable: true, get: () => selfMinted },
  selfMintedCli: { enumerable: true, get: () => selfMintedCli },
  originalTerminalFixture: { enumerable: true, get: () => originalTerminalFixture },
  seedRetrySession: { enumerable: true, get: () => seedRetrySession },
  seedRetryAttestation: { enumerable: true, get: () => seedRetryAttestation },
  seededRetry: { enumerable: true, get: () => seededRetry },
  terminalBeforeForgedRetry: { enumerable: true, get: () => terminalBeforeForgedRetry },
  existingTerminal: { enumerable: true, get: () => existingTerminal },
  samePayloadForgedRetry: { enumerable: true, get: () => samePayloadForgedRetry },
  authorizedRetrySession: { enumerable: true, get: () => authorizedRetrySession },
  authorizedRetryEnv: { enumerable: true, get: () => authorizedRetryEnv },
  authorizedRetry: { enumerable: true, get: () => authorizedRetry },
  retryPayload: { enumerable: true, get: () => retryPayload },
  authorizedRetryResult: { enumerable: true, get: () => authorizedRetryResult },
  consumedRetry: { enumerable: true, get: () => consumedRetry },
  inlineSession: { enumerable: true, get: () => inlineSession },
  inlineAttestation: { enumerable: true, get: () => inlineAttestation },
  inheritedInline: { enumerable: true, get: () => inheritedInline },
  mixedCodexClaims: { enumerable: true, get: () => mixedCodexClaims },
  claudeBrokerKeys: { enumerable: true, get: () => claudeBrokerKeys },
  claudeDispatch: { enumerable: true, get: () => claudeDispatch },
  claudeClaims: { enumerable: true, get: () => claudeClaims },
  inheritedClaims: { enumerable: true, get: () => inheritedClaims },
  passesBeforeRawCli: { enumerable: true, get: () => passesBeforeRawCli },
  rawCli: { enumerable: true, get: () => rawCli },
  findingsBeforeRawCli: { enumerable: true, get: () => findingsBeforeRawCli },
  rawCliFinding: { enumerable: true, get: () => rawCliFinding },
  degradedPass: { enumerable: true, get: () => degradedPass },
}) as typeof context & {
  readonly attackerKeys: typeof attackerKeys;
  readonly selfMinted: typeof selfMinted;
  readonly selfMintedCli: typeof selfMintedCli;
  readonly originalTerminalFixture: typeof originalTerminalFixture;
  readonly seedRetrySession: typeof seedRetrySession;
  readonly seedRetryAttestation: typeof seedRetryAttestation;
  readonly seededRetry: typeof seededRetry;
  readonly terminalBeforeForgedRetry: typeof terminalBeforeForgedRetry;
  readonly existingTerminal: typeof existingTerminal;
  readonly samePayloadForgedRetry: typeof samePayloadForgedRetry;
  readonly authorizedRetrySession: typeof authorizedRetrySession;
  readonly authorizedRetryEnv: typeof authorizedRetryEnv;
  readonly authorizedRetry: typeof authorizedRetry;
  readonly retryPayload: typeof retryPayload;
  readonly authorizedRetryResult: typeof authorizedRetryResult;
  readonly consumedRetry: typeof consumedRetry;
  readonly inlineSession: typeof inlineSession;
  readonly inlineAttestation: typeof inlineAttestation;
  readonly inheritedInline: typeof inheritedInline;
  readonly mixedCodexClaims: typeof mixedCodexClaims;
  readonly claudeBrokerKeys: typeof claudeBrokerKeys;
  readonly claudeDispatch: typeof claudeDispatch;
  readonly claudeClaims: typeof claudeClaims;
  readonly inheritedClaims: typeof inheritedClaims;
  readonly passesBeforeRawCli: typeof passesBeforeRawCli;
  readonly rawCli: typeof rawCli;
  readonly findingsBeforeRawCli: typeof findingsBeforeRawCli;
  readonly rawCliFinding: typeof rawCliFinding;
  readonly degradedPass: typeof degradedPass;
};
}
