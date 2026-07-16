import { existsSync, readFileSync } from 'node:fs';
import type { StoryStore } from './store.js';

const LIVE_SMOKE_TRANSCRIPT_REL = 'evidence/live-smoke-transcript.json';

export type LiveSmokeTranscriptEvidenceResult =
  | { status: 'absent'; ok: true; reason: string }
  | { status: 'valid'; ok: true; reason: string }
  | { status: 'invalid'; ok: false; reason: string };

export function evaluateLiveSmokeTranscriptValue(
  parsed: unknown,
  storyId: string,
): Exclude<LiveSmokeTranscriptEvidenceResult, { status: 'absent' }> {
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'invalid', ok: false, reason: 'live-smoke transcript must be a JSON object' };
  }

  const artifact = parsed as {
    storyId?: unknown;
    mode?: { runCommands?: unknown };
    actual?: { exitCode?: unknown } | null;
  };
  if (artifact.storyId !== storyId) {
    return { status: 'invalid', ok: false, reason: 'live-smoke transcript storyId does not match the active story' };
  }
  if (artifact.mode?.runCommands !== true || !artifact.actual) {
    return { status: 'invalid', ok: false, reason: 'live-smoke transcript contains no executed command result' };
  }
  if (artifact.actual.exitCode !== 0) {
    const rendered = artifact.actual.exitCode === null ? 'null (timeout/spawn failure)' : String(artifact.actual.exitCode);
    return { status: 'invalid', ok: false, reason: `live-smoke transcript command did not pass (exitCode=${rendered})` };
  }
  return { status: 'valid', ok: true, reason: 'live-smoke transcript records a successful command exit' };
}

/**
 * A live-smoke transcript remains optional for legacy stories, but once the
 * canonical artifact exists it must describe a command that actually exited
 * successfully. Presence/freshness alone must never turn a timeout, spawn
 * failure, or non-zero exit into positive delivery evidence.
 */
export function evaluateOptionalLiveSmokeTranscript(
  store: StoryStore,
  storyId: string,
): LiveSmokeTranscriptEvidenceResult {
  const artifactPath = store.storyFilePath(storyId, LIVE_SMOKE_TRANSCRIPT_REL);
  if (!existsSync(artifactPath)) {
    return { status: 'absent', ok: true, reason: 'No canonical live-smoke transcript is recorded' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    return { status: 'invalid', ok: false, reason: 'live-smoke transcript is unreadable or malformed' };
  }
  return evaluateLiveSmokeTranscriptValue(parsed, storyId);
}
