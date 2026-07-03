#!/usr/bin/env node
/**
 * B-7ee1 smoke entrypoint.
 *
 * The B-9958 seed-promotion loop smoke now contains the full evidence-activation
 * path: seed -> candidate -> explicit outcomes -> applied recommend_activate ->
 * evidence-activated apply -> runtime consumption -> demotion recommendation.
 * Keep this dedicated entrypoint so Story evidence can name the B-7ee1 behavior
 * directly without duplicating the hermetic fixture.
 */

await import('./playbook-seed-promotion-loop-smoke.js');
