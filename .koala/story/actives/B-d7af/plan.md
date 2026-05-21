## CHK-001

Goal: remove the core-to-handler import by extracting the init-check integrity and gate primitives into a core module, while preserving the current init_check_set command behavior and INIT_CHECK gate semantics.

Steps:
1. Create packages/main/src/core/init-check-gate.ts using the delivery-check-hash precedent. Move the signature salt, required reviewer list, agent matching/results helpers, blocking issue helper, background/checklist hash helpers, signInitCheck, and recomputeInitCheckHash into it.
2. Update packages/main/src/handlers/init-check.ts so it remains the command handler and metadata lock/write shell, importing the shared primitives from the new core module. Keep compatibility exports from the handler only if existing callers need them.
3. Update packages/main/src/core/machine.ts to import init-check primitives from ./init-check-gate.js, not ../handlers/init-check.js.
4. Review process-fact registry strings: keep producer/owner as handlers/init-check where they describe the init_check_set command, but ensure no source import from core to handlers remains.
5. Verify with npm run build, npm run test:init-check-bootstrap, npm run test:worktree-authority-smoke, and rg evidence showing packages/main/src/core has no import from ../handlers/init-check.js.

Evidence mapping:
- CHK-001:happy:0 -> TypeScript build and source grep proving shared core module wiring.
- CHK-001:edge:0 -> init-check bootstrap/worktree authority smoke proving required reviewer paths still pass.
- CHK-001:adversarial:0 -> targeted smoke plus grep proving missing/tampered/blocking checks and layer boundary remain enforced.
