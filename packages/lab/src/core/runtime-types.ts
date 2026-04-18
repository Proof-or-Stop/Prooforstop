export interface LabRegistry {
  registerBatch(map: Record<string, (...args: any[]) => any>): void;
}

export interface LabHandlerContext {
  root: string;
}
