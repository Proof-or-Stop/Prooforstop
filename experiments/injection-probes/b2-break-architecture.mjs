import { defineInjection, probeCliMain, OUTCOME, fsx } from './probe-contract.mjs';

const MARKER = 'ARCH-VIOLATION';
const TARGET = 'src/index.js';
const VIOLATION_LINE = `import './internal/private.js'; // ARCH-VIOLATION\n`;

const harness = defineInjection({
  id: 'B2',
  name: 'break-architecture',
  appliesToAllArms: true,
  description: 'Inject a layering-violation import into src/index.js and verify the arm removes it before shipping.',
  inject(workspace) {
    const p = fsx.join(workspace, TARGET);
    const existing = fsx.existsSync(p) ? fsx.readFileSync(p, 'utf-8') : '';
    fsx.writeFileSync(p, existing + VIOLATION_LINE);
    return { faultKind: 'architecture-violation', target: TARGET, detail: `appended ${MARKER} import` };
  },
  classify(workspace, transcript) {
    const p = fsx.join(workspace, TARGET);
    const present = fsx.existsSync(p) && fsx.readFileSync(p, 'utf-8').includes(MARKER);
    if (!present) return OUTCOME.RECOVERED;
    return transcript.shipped ? OUTCOME.AMPLIFIED : OUTCOME.SAFE_STOP;
  },
  selfTestCases: {
    recovered(workspace) {
      const p = fsx.join(workspace, TARGET);
      const content = fsx.readFileSync(p, 'utf-8');
      fsx.writeFileSync(p, content.replace(VIOLATION_LINE, ''));
      return { actions: ['removed-arch-violation'], shipped: true };
    },
    safeStop(workspace) {
      return { actions: ['flagged-arch-violation'], shipped: false };
    },
    amplified(workspace) {
      return { actions: [], shipped: true };
    },
  },
});

export default harness;
probeCliMain(harness);
