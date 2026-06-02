import { basename } from 'path';

export const LATTICE_CLI_VERSION = '0.3.5' as const;
export const LATTICE_PRODUCT_NAME = 'Lattice CLI' as const;
export const KOALA_LEGACY_ALIAS = 'koala' as const;
export const LATTICE_PRIMARY_BIN = 'lattice' as const;

export interface LatticeBrand {
  productName: typeof LATTICE_PRODUCT_NAME;
  version: typeof LATTICE_CLI_VERSION;
  primaryBin: typeof LATTICE_PRIMARY_BIN;
  legacyAlias: typeof KOALA_LEGACY_ALIAS;
  invokedAs: string;
  isLegacyAlias: boolean;
}

export function detectLatticeBrand(argv: string[] = process.argv): LatticeBrand {
  const invokedAs = basename(argv[1] || LATTICE_PRIMARY_BIN).replace(/\.(?:js|cjs|mjs)$/i, '');
  return {
    productName: LATTICE_PRODUCT_NAME,
    version: LATTICE_CLI_VERSION,
    primaryBin: LATTICE_PRIMARY_BIN,
    legacyAlias: KOALA_LEGACY_ALIAS,
    invokedAs,
    isLegacyAlias: invokedAs === KOALA_LEGACY_ALIAS || invokedAs === 'koala-codex',
  };
}

export function formatLatticeProductLine(brand: LatticeBrand = detectLatticeBrand()): string {
  return `${brand.productName} ${brand.version}`;
}

export function formatLatticeVersionLine(brand: LatticeBrand = detectLatticeBrand()): string {
  const alias = brand.isLegacyAlias ? `; invoked through legacy alias ${brand.invokedAs}` : `; legacy alias: ${brand.legacyAlias}`;
  return `${formatLatticeProductLine(brand)} (${brand.primaryBin}${alias})`;
}

