export const PRODUCT_IDENTITY = {
  baseName: "Code Work",
  stages: {
    development: "Dev",
    nightly: "Nightly",
    preview: "Preview",
    production: "Alpha",
  },
  schemes: {
    production: "codework",
    development: "codework-dev",
    preview: "codework-preview",
  },
  legacySchemes: ["t3code", "t3code-dev", "t3code-preview"] as const,
  dataDirectories: {
    base: ".code-work",
    development: "code-work-dev",
    production: "code-work",
  },
  legacyDataDirectories: {
    base: ".t3",
    development: "t3code-dev",
    production: "t3code",
  },
  environmentPrefix: "CODEWORK",
  legacyEnvironmentPrefix: "T3CODE",
} as const;

export type ProductStage = keyof typeof PRODUCT_IDENTITY.stages;

export type ProductEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveProductDisplayName(stage: ProductStage): string {
  const stageLabel = PRODUCT_IDENTITY.stages[stage];
  return stage === "production"
    ? `${PRODUCT_IDENTITY.baseName} (${stageLabel})`
    : `${PRODUCT_IDENTITY.baseName} (${stageLabel})`;
}

export function resolveProductScheme(stage: ProductStage): string {
  if (stage === "development") return PRODUCT_IDENTITY.schemes.development;
  if (stage === "preview") return PRODUCT_IDENTITY.schemes.preview;
  return PRODUCT_IDENTITY.schemes.production;
}

export function resolveProductSchemes(stage: ProductStage): readonly string[] {
  const canonical = resolveProductScheme(stage);
  const legacy =
    stage === "development" ? "t3code-dev" : stage === "preview" ? "t3code-preview" : "t3code";
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function resolveDataDirectoryCandidates(input: {
  readonly homeDirectory: string;
  readonly isDevelopment: boolean;
  readonly joinPath: (first: string, ...segments: string[]) => string;
}): readonly string[] {
  const canonical = input.joinPath(
    input.homeDirectory,
    input.isDevelopment
      ? PRODUCT_IDENTITY.dataDirectories.development
      : PRODUCT_IDENTITY.dataDirectories.production,
  );
  const legacy = input.joinPath(
    input.homeDirectory,
    input.isDevelopment
      ? PRODUCT_IDENTITY.legacyDataDirectories.development
      : PRODUCT_IDENTITY.legacyDataDirectories.production,
  );
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function resolvePreferredEnv(
  environment: ProductEnvironment,
  canonicalName: string,
  legacyName: string,
): string | undefined {
  const canonical = environment[canonicalName]?.trim();
  if (canonical) {
    return canonical;
  }
  const legacy = environment[legacyName]?.trim();
  return legacy || undefined;
}

export function resolvePrefixedEnv(
  environment: ProductEnvironment,
  suffix: string,
): string | undefined {
  return resolvePreferredEnv(
    environment,
    `${PRODUCT_IDENTITY.environmentPrefix}_${suffix}`,
    `${PRODUCT_IDENTITY.legacyEnvironmentPrefix}_${suffix}`,
  );
}

export function isLegacyProductIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "t3" ||
    normalized === "t3code" ||
    normalized === "t3 code" ||
    normalized === "t3-code" ||
    normalized === "codeworktools" ||
    normalized.startsWith("t3code-")
  );
}
