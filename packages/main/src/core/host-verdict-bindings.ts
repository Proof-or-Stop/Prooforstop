import { canonicalDigest } from './authority-signing.js';
import { isCanonicalStoryId } from './lifecycle-registry.js';

export const HOST_VERDICT_VALIDATION_DIGEST_SCHEMA = 'proof-or-stop.quorum_submit.validation_digest.v1';
export const HOST_VERDICT_PROMPT_DIGEST_SCHEMA = 'proof-or-stop.quorum_submit.prompt_digest.v1';
export const HOST_VERDICT_PROMPT_PURPOSE = 'local voluntary 3x2 review quorum after signed reviewer passes';

export interface HostVerdictBindingInput {
  storyId: string;
  headHash?: string;
  materialDigest: string;
  storyFilesHash: string;
  testEvidence: unknown;
  hostId: string;
  provider: string;
  sessionId: string;
  keyId?: string;
}

export interface HostVerdictBindings {
  keyId: string;
  validationDigest: string;
  promptDigest: string;
}

function requireCanonicalField(name: string, value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`host-verdict bindings require non-empty ${name}`);
  return normalized;
}

export function deriveCanonicalHostKeyId(storyId: string, hostId: string): string {
  const canonicalStoryId = requireCanonicalField('storyId', storyId);
  if (!isCanonicalStoryId(canonicalStoryId)) throw new Error('host-verdict bindings require a canonical storyId');
  return `quorum:${canonicalStoryId}:${requireCanonicalField('hostId', hostId)}:key`;
}

export function deriveHostVerdictBindings(input: HostVerdictBindingInput): HostVerdictBindings {
  const storyId = requireCanonicalField('storyId', input.storyId);
  if (!isCanonicalStoryId(storyId)) throw new Error('host-verdict bindings require a canonical storyId');
  const materialDigest = requireCanonicalField('materialDigest', input.materialDigest);
  const storyFilesHash = requireCanonicalField('storyFilesHash', input.storyFilesHash);
  const hostId = requireCanonicalField('hostId', input.hostId);
  const provider = requireCanonicalField('provider', input.provider);
  const sessionId = requireCanonicalField('sessionId', input.sessionId);
  const keyId = input.keyId === undefined
    ? deriveCanonicalHostKeyId(storyId, hostId)
    : requireCanonicalField('keyId', input.keyId);

  return {
    keyId,
    validationDigest: canonicalDigest({
      schemaVersion: HOST_VERDICT_VALIDATION_DIGEST_SCHEMA,
      storyId,
      headHash: input.headHash,
      materialDigest,
      storyFilesHash,
      testEvidence: input.testEvidence,
    }),
    promptDigest: canonicalDigest({
      schemaVersion: HOST_VERDICT_PROMPT_DIGEST_SCHEMA,
      purpose: HOST_VERDICT_PROMPT_PURPOSE,
      storyId,
      hostId,
      provider,
      sessionId,
      keyId,
      materialDigest,
      storyFilesHash,
    }),
  };
}
