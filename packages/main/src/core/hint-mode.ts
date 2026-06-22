// B-06b3 CHK-001: Pure deterministic A/B hint-mode leaf.
//
// Assigns each story a stable on/off arm for the Experience Layer ③.3
// shadow-gated experience-hint experiment. The arm is derived purely from the
// storyId via sha256 parity, so the SAME storyId always lands in the SAME arm
// (reproducible, no persisted state) and the split is roughly balanced across
// ids. This leaf is intentionally pure: imports only node:crypto, no fs/git,
// no time, no randomness, no env, no mutable state.
import { createHash } from 'node:crypto';

export type HintMode = 'on' | 'off';

/**
 * Map a storyId to a deterministic A/B arm.
 *
 * Determinism: `sha256(storyId)` first byte parity — even => 'on', odd => 'off'.
 * The same storyId always returns the same arm (no time/random/state). Empty
 * string is tolerated (sha256('') is well-defined, yields a stable arm). The
 * split is ~balanced because the low bit of a sha256 byte is ~uniform.
 */
export function resolveHintMode(storyId: string): HintMode {
  const firstByte = createHash('sha256').update(String(storyId)).digest()[0];
  return firstByte % 2 === 0 ? 'on' : 'off';
}
