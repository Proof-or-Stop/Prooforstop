export function isCanonicalStory6Provenance(provenance) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  return provenance?.kind === 'production-provider-dispatch'
    && provenance?.producer === 'agent_prompt'
    && provenance?.producerMode === 'full-envelope'
    && digest(provenance?.producerResponseDigest)
    && digest(provenance?.envelopeId)
    && provenance?.eventBinding?.promptEnvelopeId === provenance.envelopeId
    && digest(provenance?.eventBinding?.assembledPromptDigest)
    && provenance?.gateEvidence === false;
}

export function assertCanonicalStory6Provenance(provenance, label = 'Story 6 provenance') {
  if (!isCanonicalStory6Provenance(provenance)) {
    throw new Error(`${label} must bind the canonical full envelope and persisted dispatch event`);
  }
}
