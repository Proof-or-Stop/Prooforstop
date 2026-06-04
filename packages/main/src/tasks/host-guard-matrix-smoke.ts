#!/usr/bin/env node
/**
 * Host guard matrix smoke test.
 *
 * Verifies that guard mode resolution matches the host capability truth table:
 *   - claude-code + nativeHookVerified=true  → native-pretool
 *   - claude-code + nativeHookVerified=false → watcher-fallback
 *   - codex       + nativeHookVerified=true  → native-pretool
 *   - codex       + viaDispatch=true         → wrapped-preapply
 *   - codex       + no verified context      → watcher-fallback
 *   - gemini      + viaDispatch=true         → wrapped-preapply
 *   - gemini      + viaDispatch=false        → watcher-fallback
 *   - fake                                   → watcher-fallback
 *   - other/unknown                          → watcher-fallback
 *   - legacy 'active' mode renders as 'native-pretool' (backwards compat)
 */

import assert from 'node:assert/strict';
import {
  resolveGuardMode,
  guardModeLabel,
  guardSessionStateLabel,
  renderGuardModeDiagnostic,
  GUARD_NATIVE_PRETOOL_PROVIDERS,
  GUARD_WRAPPED_PREAPPLY_PROVIDERS,
  GUARD_PRELAUNCH_PROVIDERS,
  buildGuardSession,
} from '../core/guard-session.js';
import {
  buildCapabilityList,
  buildCapabilityProbe,
} from '../core/capabilities.js';
import type { GuardSessionData } from '../core/types.js';

// ── 1. resolveGuardMode truth table ─────────────────────────────────────────

// Claude Code: native-pretool only when hook is verified
assert.equal(
  resolveGuardMode('claude-code', { nativeHookVerified: true }),
  'native-pretool',
  'claude-code + nativeHookVerified=true → native-pretool',
);
assert.equal(
  resolveGuardMode('claude-code', { nativeHookVerified: false }),
  'watcher-fallback',
  'claude-code + nativeHookVerified=false → watcher-fallback',
);
assert.equal(
  resolveGuardMode('claude-code', {}),
  'watcher-fallback',
  'claude-code + no context → watcher-fallback',
);
assert.equal(
  resolveGuardMode('claude-code'),
  'watcher-fallback',
  'claude-code + missing context → watcher-fallback',
);

// Aliases for Claude Code
for (const alias of ['claude', 'claude_code', 'claudecode']) {
  assert.equal(
    resolveGuardMode(alias, { nativeHookVerified: true }),
    'native-pretool',
    `${alias} + nativeHookVerified=true → native-pretool`,
  );
  assert.equal(
    resolveGuardMode(alias, { nativeHookVerified: false }),
    'watcher-fallback',
    `${alias} + nativeHookVerified=false → watcher-fallback`,
  );
}

// Case-insensitive normalization
assert.equal(
  resolveGuardMode('Claude-Code', { nativeHookVerified: true }),
  'native-pretool',
  'Claude-Code (mixed case) + nativeHookVerified=true → native-pretool',
);
assert.equal(
  resolveGuardMode('CLAUDE-CODE', { nativeHookVerified: true }),
  'native-pretool',
  'CLAUDE-CODE (upper) + nativeHookVerified=true → native-pretool',
);

// Codex: native-pretool when official .codex hook is verified, otherwise wrapped-preapply via dispatch
assert.equal(
  resolveGuardMode('codex', { nativeHookVerified: true }),
  'native-pretool',
  'codex + nativeHookVerified=true → native-pretool',
);
assert.equal(
  resolveGuardMode('codex', { nativeHookVerified: true, viaDispatch: true }),
  'native-pretool',
  'codex + nativeHookVerified=true takes precedence over viaDispatch',
);
assert.equal(
  resolveGuardMode('codex', { viaDispatch: true }),
  'wrapped-preapply',
  'codex + viaDispatch=true → wrapped-preapply',
);
assert.equal(
  resolveGuardMode('codex', { viaDispatch: false }),
  'watcher-fallback',
  'codex + viaDispatch=false → watcher-fallback',
);
assert.equal(
  resolveGuardMode('codex', {}),
  'watcher-fallback',
  'codex + no dispatch context → watcher-fallback',
);
assert.equal(
  resolveGuardMode('codex'),
  'watcher-fallback',
  'codex + missing context → watcher-fallback',
);

// Gemini: wrapped-preapply only via dispatch
assert.equal(
  resolveGuardMode('gemini', { viaDispatch: true }),
  'wrapped-preapply',
  'gemini + viaDispatch=true → wrapped-preapply',
);
assert.equal(
  resolveGuardMode('gemini', { viaDispatch: false }),
  'watcher-fallback',
  'gemini + viaDispatch=false → watcher-fallback',
);

// fake: always watcher-fallback
assert.equal(
  resolveGuardMode('fake', { nativeHookVerified: true, viaDispatch: true }),
  'watcher-fallback',
  'fake + all context flags → watcher-fallback',
);

// unknown providers: always watcher-fallback
for (const unknown of ['', 'other-host', 'some-agent', 'browser', 'server']) {
  assert.equal(
    resolveGuardMode(unknown, { nativeHookVerified: true, viaDispatch: true }),
    'watcher-fallback',
    `unknown provider "${unknown}" → watcher-fallback`,
  );
}

// ── 2. Provider set correctness ──────────────────────────────────────────────

assert.equal(GUARD_NATIVE_PRETOOL_PROVIDERS.has('claude-code'), true);
assert.equal(GUARD_NATIVE_PRETOOL_PROVIDERS.has('codex'), true, 'codex is native-pretool capable when .codex hook is verified');
assert.equal(GUARD_NATIVE_PRETOOL_PROVIDERS.has('gemini'), false, 'gemini is NOT native-pretool');
assert.equal(GUARD_NATIVE_PRETOOL_PROVIDERS.has('fake'), false, 'fake is NOT native-pretool');

assert.equal(GUARD_WRAPPED_PREAPPLY_PROVIDERS.has('codex'), true);
assert.equal(GUARD_WRAPPED_PREAPPLY_PROVIDERS.has('gemini'), true);
assert.equal(GUARD_WRAPPED_PREAPPLY_PROVIDERS.has('claude-code'), false, 'claude-code is NOT wrapped-preapply');
assert.equal(GUARD_WRAPPED_PREAPPLY_PROVIDERS.has('fake'), false, 'fake is NOT wrapped-preapply');

// legacy alias kept
assert.equal(GUARD_PRELAUNCH_PROVIDERS === GUARD_NATIVE_PRETOOL_PROVIDERS, true, 'legacy alias points to same set');

// ── 3. guardModeLabel normalizes legacy 'active' ─────────────────────────────

assert.equal(guardModeLabel('native-pretool'), 'native-pretool');
assert.equal(guardModeLabel('wrapped-preapply'), 'wrapped-preapply');
assert.equal(guardModeLabel('watcher-fallback'), 'watcher-fallback');
assert.equal(guardModeLabel('inactive'), 'inactive');
assert.match(guardModeLabel('active'), /native-pretool/, "legacy 'active' label includes native-pretool");

// ── 4. guardSessionStateLabel avoids overclaiming ───────────────────────────

assert.equal(guardSessionStateLabel(null), 'inactive');
assert.equal(guardSessionStateLabel(undefined), 'inactive');

const makeSession = (mode: GuardSessionData['guardMode'], status: GuardSessionData['status'] = 'active'): GuardSessionData => ({
  storyId: 'B-test',
  provider: 'test',
  guardMode: mode,
  status,
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  violations: [],
});

assert.equal(guardSessionStateLabel(makeSession('native-pretool')), 'native-pretool');
assert.equal(guardSessionStateLabel(makeSession('wrapped-preapply')), 'wrapped-preapply');
assert.equal(guardSessionStateLabel(makeSession('watcher-fallback')), 'watcher-fallback');
assert.equal(guardSessionStateLabel(makeSession('active')), 'native-pretool', "legacy 'active' renders as 'native-pretool'");
assert.equal(guardSessionStateLabel(makeSession('native-pretool', 'stopped')), 'inactive');
assert.equal(
  guardSessionStateLabel({ ...makeSession('native-pretool'), violations: [{ path: 'x.ts', rule: 'protected', detectedAt: '' }] }),
  'violations detected',
);

// ── 5. renderGuardModeDiagnostic does not overclaim ─────────────────────────

const nativeDiag = renderGuardModeDiagnostic('native-pretool');
assert.match(nativeDiag, /native-pretool/, 'native-pretool diagnostic mentions mode');
assert.match(nativeDiag, /hook/, 'native-pretool diagnostic mentions hook');

const wrappedDiag = renderGuardModeDiagnostic('wrapped-preapply');
assert.match(wrappedDiag, /wrapped-preapply/, 'wrapped-preapply diagnostic mentions mode');
assert.match(wrappedDiag, /dispatch/, 'wrapped-preapply diagnostic mentions dispatch');

const watcherDiag = renderGuardModeDiagnostic('watcher-fallback');
assert.match(watcherDiag, /watcher-fallback/, 'watcher-fallback diagnostic mentions mode');
assert.doesNotMatch(watcherDiag, /intercept(?!.*only)/i, 'watcher-fallback should not claim write interception');

// Legacy 'active' alias
const activeDiag = renderGuardModeDiagnostic('active');
assert.match(activeDiag, /native-pretool/, "legacy 'active' diagnostic renders as native-pretool");

// ── 6. buildGuardSession respects context ────────────────────────────────────

const ccSession = buildGuardSession({ storyId: 'B-x', provider: 'claude-code', context: { nativeHookVerified: true } });
assert.equal(ccSession.guardMode, 'native-pretool', 'claude-code + verified hook → native-pretool session');

const ccFallback = buildGuardSession({ storyId: 'B-x', provider: 'claude-code', context: { nativeHookVerified: false } });
assert.equal(ccFallback.guardMode, 'watcher-fallback', 'claude-code + no hook → watcher-fallback session');

const codexDispatch = buildGuardSession({ storyId: 'B-x', provider: 'codex', context: { viaDispatch: true } });
assert.equal(codexDispatch.guardMode, 'wrapped-preapply', 'codex + dispatch → wrapped-preapply session');

const codexNative = buildGuardSession({ storyId: 'B-x', provider: 'codex', context: { nativeHookVerified: true } });
assert.equal(codexNative.guardMode, 'native-pretool', 'codex + verified hook → native-pretool session');

const codexDirect = buildGuardSession({ storyId: 'B-x', provider: 'codex', context: { viaDispatch: false } });
assert.equal(codexDirect.guardMode, 'watcher-fallback', 'codex + no dispatch → watcher-fallback session');

const geminiDispatch = buildGuardSession({ storyId: 'B-x', provider: 'gemini', context: { viaDispatch: true } });
assert.equal(geminiDispatch.guardMode, 'wrapped-preapply', 'gemini + dispatch → wrapped-preapply session');

const fakeSession = buildGuardSession({ storyId: 'B-x', provider: 'fake', context: { nativeHookVerified: true, viaDispatch: true } });
assert.equal(fakeSession.guardMode, 'watcher-fallback', 'fake + all flags → watcher-fallback');

// ── 7. Capability registry reflects host guard truth ─────────────────────────

const list = buildCapabilityList();

// prewrite-guard is in the category list
assert.ok(list.categories.some(c => c.id === 'prewrite-guard'), 'prewrite-guard category exists');

// Every host profile has a prewrite-guard capability
for (const host of list.hosts) {
  const pg = host.capabilities.find(c => c.category === 'prewrite-guard');
  assert.ok(pg, `${host.id} has prewrite-guard capability`);
}

// claude-code is conditional (native-pretool when hook verified, else fallback)
const ccProfile = list.hosts.find(h => h.id === 'claude-code')!;
assert.ok(ccProfile, 'claude-code profile exists');
const ccPG = ccProfile.capabilities.find(c => c.category === 'prewrite-guard')!;
assert.equal(ccPG.status, 'conditional', 'claude-code prewrite-guard is conditional (hook must be verified)');
const ccPGDeg = ccProfile.degradations.find(d => d.capability === 'prewrite-guard');
assert.ok(ccPGDeg, 'claude-code has prewrite-guard degradation explaining hook requirement');
assert.match(ccPGDeg!.reason, /hook|pretool|PreToolUse/i, 'claude-code prewrite-guard degradation mentions hook');

// codex is conditional (native-pretool via .codex hook, wrapped-preapply via dispatch, else fallback)
const codexProfile = list.hosts.find(h => h.id === 'codex')!;
const codexPG = codexProfile.capabilities.find(c => c.category === 'prewrite-guard')!;
assert.equal(codexPG.status, 'conditional', 'codex prewrite-guard is conditional');
const codexPGDeg = codexProfile.degradations.find(d => d.capability === 'prewrite-guard');
assert.ok(codexPGDeg, 'codex has prewrite-guard degradation');
assert.match(codexPGDeg!.reason, /\.codex|hook|dispatch|wrapped/i, 'codex prewrite-guard degradation mentions hook or dispatch');

// gemini is conditional (wrapped-preapply via dispatch, else fallback)
const geminiProfile = list.hosts.find(h => h.id === 'gemini')!;
const geminiPG = geminiProfile.capabilities.find(c => c.category === 'prewrite-guard')!;
assert.equal(geminiPG.status, 'conditional', 'gemini prewrite-guard is conditional');

// Non-editing hosts: prewrite-guard is unavailable
for (const hostId of ['local-runner', 'browser', 'server', 'desktop-app', 'unknown/fallback']) {
  const profile = list.hosts.find(h => h.id === hostId)!;
  const pg = profile.capabilities.find(c => c.category === 'prewrite-guard')!;
  assert.equal(pg.status, 'unavailable', `${hostId} prewrite-guard is unavailable`);
  // unavailable means degradation must exist
  const deg = profile.degradations.find(d => d.capability === 'prewrite-guard');
  assert.ok(deg, `${hostId} has prewrite-guard degradation for unavailable status`);
}

// Probes reflect capability correctly
const ccProbe = buildCapabilityProbe('claude-code');
const ccPGProbe = ccProbe.profile.capabilities.find(c => c.category === 'prewrite-guard');
assert.equal(ccPGProbe?.status, 'conditional', 'capability_probe for claude-code shows prewrite-guard=conditional');

const fakeProbe = buildCapabilityProbe('not-a-real-host');
const fallbackPGProbe = fakeProbe.profile.capabilities.find(c => c.category === 'prewrite-guard');
assert.equal(fallbackPGProbe?.status, 'unavailable', 'unknown/fallback probe shows prewrite-guard=unavailable');

// ── 8. Guard mode does not depend on viaDispatch for claude-code ─────────────
// and nativeHookVerified only applies to hosts with a known native hook

assert.equal(
  resolveGuardMode('claude-code', { viaDispatch: true }),
  'watcher-fallback',
  'claude-code with viaDispatch=true but no nativeHookVerified → watcher-fallback (dispatch context irrelevant)',
);
assert.equal(
  resolveGuardMode('gemini', { nativeHookVerified: true, viaDispatch: false }),
  'watcher-fallback',
  'gemini with nativeHookVerified but no viaDispatch → watcher-fallback',
);

console.log('✓ host guard matrix smoke passed');
