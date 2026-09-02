declare module '@proof-or-stop/lab' {
  export function createLabToolDefs(z: unknown): any[];

  export function register(
    registry: { registerBatch(map: Record<string, (...args: any[]) => any>): void },
    context: { root: string },
  ): void;
}
