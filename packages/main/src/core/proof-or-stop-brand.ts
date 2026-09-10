import { basename } from 'path';

/**
 * NOTE on the `PROOF_OR_STOP_CLI_VERSION` name: this one identifier is NOT renamed.
 * `core/version-bump.ts` rewrites this line on every DONE merge via a regex
 * anchored to the literal token (`BRAND_EXPORT_RE`), and `.githooks/pre-push`
 * plus `rollout-check` compare it against four package/lock sync points.
 * Renaming the symbol without renaming that regex in the same commit does not
 * fail loudly — the bump silently stops finding the constant. It is kept
 * verbatim and aliased forward instead; see PROOF_OR_STOP_CLI_VERSION below.
 */
export const PROOF_OR_STOP_CLI_VERSION = '0.3.309' as const;

/**
 * Brand-forward READ alias for {@link PROOF_OR_STOP_CLI_VERSION}. New code should read
 * this name; the declaration above stays as-is because it is the write target of
 * the version-bump regex. Do not make this the declaration site.
 */

export const PROOF_OR_STOP_PRODUCT_NAME = 'Proof-or-Stop' as const;
export const PROOF_OR_STOP_PRIMARY_BIN = 'proof-or-stop' as const;
/** Canonical root package identity used by self-host/runtime checks. */
export const PROOF_OR_STOP_ROOT_PACKAGE_NAME = 'proof-or-stop' as const;

/** Canonical local Codex entrypoint basename (`bin/proof-or-stop-codex.js`). */
export const PROOF_OR_STOP_PRIMARY_CODEX_BIN = 'proof-or-stop-codex' as const;

/**
 * Every canonical bin token the CLI answers to.
 *
 * The Codex wrappers are included so that invoking them prints a usage line the
 * reader can actually paste back: without them, `resolveUsageBin` would treat
 * `proof-or-stop-codex` as an unrecognized script and print the plain
 * `proof-or-stop` usage, losing the `source=codex` entrypoint the operator used.
 * Unrecognized invocation names are excluded and fall back to the canonical
 * `proof-or-stop` usage form.
 */
export const PROOF_OR_STOP_BIN_NAMES: readonly string[] = [
  PROOF_OR_STOP_PRIMARY_BIN,
  PROOF_OR_STOP_PRIMARY_CODEX_BIN,
];

export interface ProofOrStopBrand {
  productName: typeof PROOF_OR_STOP_PRODUCT_NAME;
  version: typeof PROOF_OR_STOP_CLI_VERSION;
  primaryBin: typeof PROOF_OR_STOP_PRIMARY_BIN;
  /** Raw basename of argv[1], extension stripped. May be any script name. */
  invokedAs: string;
  /**
   * The bin token that usage/help lines should print. Equals `invokedAs` only
   * when the CLI was actually invoked through a recognized canonical bin name
   * (`proof-or-stop` or `proof-or-stop-codex`); otherwise it falls back to
   * `primaryBin`. Without this normalization, running the compiled entry
   * directly (`node packages/main/dist/cli.js help`, argv[1] basename `cli`)
   * would print `Usage: cli <command>` — an instruction that does not resolve.
   */
  usageBin: string;
}

/**
 * Narrow a raw invocation basename to a canonical bin token safe to print in
 * usage text. Retired aliases and arbitrary script names fall back to the
 * canonical `proof-or-stop` bin.
 */
export function resolveUsageBin(invokedAs: string): string {
  return PROOF_OR_STOP_BIN_NAMES.includes(invokedAs) ? invokedAs : PROOF_OR_STOP_PRIMARY_BIN;
}

export function detectProofOrStopBrand(argv: string[] = process.argv): ProofOrStopBrand {
  const invokedAs = basename(argv[1] || PROOF_OR_STOP_PRIMARY_BIN).replace(/\.(?:js|cjs|mjs)$/i, '');
  return {
    productName: PROOF_OR_STOP_PRODUCT_NAME,
    version: PROOF_OR_STOP_CLI_VERSION,
    primaryBin: PROOF_OR_STOP_PRIMARY_BIN,
    invokedAs,
    usageBin: resolveUsageBin(invokedAs),
  };
}

export function formatProofOrStopProductLine(
  brand: ProofOrStopBrand = detectProofOrStopBrand(),
): string {
  return `${brand.productName} ${brand.version}`;
}

/*
 * Deprecated brand aliases (B-cdf6 CHK-006).
 *
 * Durable, not transitional: this repository is multi-developer, so a teammate
 * branch importing the old symbol must keep compiling when it merges. Never remove.
 *
 * Every alias below is a pure re-export of the canonical symbol above — same
 * value, same identity — so there is no second source of truth to drift.
 */
/** @deprecated Use `formatProofOrStopProductLine`. */
/** @deprecated Use `formatProofOrStopProductLine`. */
export const formatProofOrStopVersionLine = formatProofOrStopProductLine;
/** @deprecated Use `PROOF_OR_STOP_PRODUCT_NAME`. */
/** @deprecated Use `PROOF_OR_STOP_PRIMARY_BIN`. */
/** @deprecated Use `PROOF_OR_STOP_PRIMARY_CODEX_BIN`. */
/** @deprecated Use `PROOF_OR_STOP_BIN_NAMES`. */
/** @deprecated Use `detectProofOrStopBrand`. */
/** @deprecated Use `ProofOrStopBrand`. */
