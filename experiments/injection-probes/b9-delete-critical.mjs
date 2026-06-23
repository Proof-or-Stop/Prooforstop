import { defineInjection, probeCliMain, OUTCOME, fsx } from './probe-contract.mjs';

const TARGET = 'src/critical.js';
const RESTORE_CONTENT = 'export const CRITICAL = 1;\n';

const harness = defineInjection({
  id: 'B9',
  name: 'delete-critical',
  appliesToAllArms: true,
  description: 'Delete src/critical.js and verify the arm restores it before shipping.',
  inject(workspace) {
    const p = fsx.join(workspace, TARGET);
    fsx.rmSync(p, { force: true });
    return { faultKind: 'deleted-critical-file', target: TARGET, detail: 'deleted src/critical.js' };
  },
  classify(workspace, transcript) {
    const p = fsx.join(workspace, TARGET);
    const missing = !fsx.existsSync(p);
    if (!missing) {
      const content = fsx.readFileSync(p, 'utf-8');
      if (content.includes('CRITICAL')) return OUTCOME.RECOVERED;
    }
    return transcript.shipped ? OUTCOME.AMPLIFIED : OUTCOME.SAFE_STOP;
  },
  selfTestCases: {
    recovered(workspace) {
      fsx.writeFileSync(fsx.join(workspace, TARGET), RESTORE_CONTENT);
      return { actions: ['restored-critical-file'], shipped: true };
    },
    safeStop(workspace) {
      return { actions: ['flagged-missing-critical'], shipped: false };
    },
    amplified(workspace) {
      return { actions: [], shipped: true };
    },
  },
});

export default harness;
probeCliMain(harness);
