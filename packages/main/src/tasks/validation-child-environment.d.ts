export declare const VALIDATION_CHILD_ENVIRONMENT_KEYS: readonly string[];
export declare function validationChildEnvironment(
  overrides?: Readonly<Record<string, string | undefined>>,
  source?: NodeJS.ProcessEnv,
): Record<string, string>;
