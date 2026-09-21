#!/usr/bin/env node
import { runIdentityCliIfMain } from './identity-cutover/cli.mjs';
export { identityCutoverReviewedContexts } from './identity-cutover/public-api.mjs';

// Full certification: no arguments. List: --list-capabilities.
// Focus: --capability=ordering; legacy inspection flags remain unchanged.
// Imports expose the existing read-only API without starting certification.
runIdentityCliIfMain(import.meta.url, process.argv.slice(2));
