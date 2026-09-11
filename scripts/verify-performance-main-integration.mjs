import { assertCanonicalActiveIdentityBoundary } from '../packages/main/dist/core/runtime-environment-checks.js';
import { resolve } from 'node:path';
// Exercise the real production boundary; a stale compiled checklist pin blocks valid consumers.
assertCanonicalActiveIdentityBoundary({ boundaryId: 'review-inventory-epoch', runtimePackageRoot: resolve('packages/main') });
console.log('PERFORMANCE_MAIN_INTEGRATION_GREEN valid inventory consumer accepted');
