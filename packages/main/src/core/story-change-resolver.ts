import {
  buildStoryChangeManifest as buildCanonicalStoryChangeManifest,
  type StoryChangeManifest,
  type StoryChangeResolverInput,
} from './story-aware-validation.js';

/**
 * Stable compatibility entrypoint for the story change resolver. Keeping a
 * named implementation here lets topology discovery bind the planned
 * producer endpoint to the runtime import surface.
 */
export function buildStoryChangeManifest(input: StoryChangeResolverInput): StoryChangeManifest {
  return buildCanonicalStoryChangeManifest(input);
}

export * from './story-aware-validation.js';
