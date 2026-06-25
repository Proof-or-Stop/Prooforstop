#!/usr/bin/env node

import assert from 'node:assert/strict';

import * as legacyArtifactStore from '../core/evidence/artifact-store.js';
import * as artifactEntry from '../core/evidence/artifact/index.js';
import * as storageEntry from '../core/evidence/storage/index.js';
import * as legacyRepro from '../core/repro-intake.js';
import * as reproEntry from '../core/evidence/repro/index.js';
import * as legacyAdmissibility from '../core/proof-admissibility.js';
import * as admissibilityEntry from '../core/evidence/admissibility/index.js';
import {
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES,
  type ProjectControlStatus,
  type StoryControlStatus,
} from '../core/lifecycle-control/index.js';
import type { EvidenceArtifact as LegacyEvidenceArtifact } from '../core/evidence/types.js';
import type { EvidenceArtifact as ArtifactEntryEvidenceArtifact } from '../core/evidence/artifact/index.js';
import type { EvidenceArtifact as StorageEntryEvidenceArtifact } from '../core/evidence/storage/index.js';

const artifactTypeRoundTrip: ArtifactEntryEvidenceArtifact = {} as LegacyEvidenceArtifact;
const storageTypeRoundTrip: StorageEntryEvidenceArtifact = artifactTypeRoundTrip;
void storageTypeRoundTrip;

assert.equal(
  artifactEntry.writeArtifact,
  legacyArtifactStore.writeArtifact,
  'evidence/artifact must re-export the legacy writeArtifact function by identity',
);
assert.equal(
  artifactEntry.readArtifact,
  legacyArtifactStore.readArtifact,
  'evidence/artifact must re-export the legacy readArtifact function by identity',
);
assert.equal(
  storageEntry.writeArtifact,
  legacyArtifactStore.writeArtifact,
  'evidence/storage must re-export the legacy writeArtifact function by identity',
);
assert.equal(
  storageEntry.verifyArtifactDigest,
  legacyArtifactStore.verifyArtifactDigest,
  'evidence/storage must re-export the legacy verifyArtifactDigest function by identity',
);
assert.equal(
  reproEntry.createProbe,
  legacyRepro.createProbe,
  'evidence/repro must re-export the legacy createProbe function by identity',
);
assert.equal(
  reproEntry.createStoryFromRepro,
  legacyRepro.createStoryFromRepro,
  'evidence/repro must re-export the legacy createStoryFromRepro function by identity',
);
assert.equal(
  admissibilityEntry.PROOF_SURFACE_REGISTRY,
  legacyAdmissibility.PROOF_SURFACE_REGISTRY,
  'evidence/admissibility must share the legacy proof surface registry object',
);
assert.equal(
  admissibilityEntry.evaluateProofAdmissibility,
  legacyAdmissibility.evaluateProofAdmissibility,
  'evidence/admissibility must re-export the legacy evaluator by identity',
);

assert.equal(
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES.length,
  5,
  'lifecycle-control migration must remain a five-milestone structural plan',
);
assert.equal(
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES[4]?.subtracks?.map(track => track.id).join(','),
  'CP-5A,CP-5B',
  'CP-5 must keep proof/Authority and cleanup enforcement split',
);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.readOnlyStatusProjection, true);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.commandRegistration, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.lifecycleGateMutation, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.evidenceWrites, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.proofM7Enforcement, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.queueCleanupEnforcement, false);

const storyStatus: StoryControlStatus = {
  storyId: 'B-88ae',
  phase: 'DEV',
  capabilities: DEFAULT_CONTROL_PLANE_CAPABILITIES,
  lanes: [
    {
      lane: 'dev',
      state: 'observed',
      source: 'control-plane-projection',
    },
  ],
  queue: {
    classification: 'none',
  },
  cp2Projection: {
    source: 'legacy-story-state',
  },
};

const projectStatus: ProjectControlStatus = {
  capabilities: DEFAULT_CONTROL_PLANE_CAPABILITIES,
  stories: [storyStatus],
  lanes: storyStatus.lanes,
  queues: [storyStatus.queue],
};
assert.equal(projectStatus.stories[0]?.storyId, 'B-88ae');

console.log('source-structure convergence smoke passed');
