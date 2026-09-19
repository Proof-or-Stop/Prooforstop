// Lab-only reproduction of periodic model dispatch. No provider or scheduler IO.
export function alwaysWake() {
  return { wake: true, reason: 'periodic' };
}

export function createMonitor() {
  return { observe: alwaysWake };
}
