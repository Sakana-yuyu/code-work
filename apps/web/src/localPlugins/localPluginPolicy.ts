import {
  LocalPluginManifest,
  negotiateLocalPluginApiVersion,
  validateLocalPluginManifest,
  type LocalPluginManifestIssue,
} from "@codework/contracts";
import * as Schema from "effect/Schema";

export type LocalPluginPolicyErrorCode = "schema-invalid" | "api-incompatible" | "manifest-invalid";

export class LocalPluginPolicyError extends Error {
  readonly code: LocalPluginPolicyErrorCode;
  readonly issues: ReadonlyArray<LocalPluginManifestIssue>;

  constructor(input: {
    readonly code: LocalPluginPolicyErrorCode;
    readonly message: string;
    readonly issues?: ReadonlyArray<LocalPluginManifestIssue>;
  }) {
    super(input.message);
    this.name = "LocalPluginPolicyError";
    this.code = input.code;
    this.issues = input.issues ?? [];
  }
}

const decodeManifest = Schema.decodeUnknownSync(LocalPluginManifest);

export function decodeAllowedLocalPluginManifest(input: unknown): LocalPluginManifest {
  let manifest: LocalPluginManifest;
  try {
    manifest = decodeManifest(input);
  } catch {
    const code = "schema-invalid" as const;
    throw new LocalPluginPolicyError({
      code,
      message: code,
    });
  }

  const compatibility = negotiateLocalPluginApiVersion(manifest.apiVersion);
  if (!compatibility.compatible) {
    const code = "api-incompatible" as const;
    throw new LocalPluginPolicyError({
      code,
      message: code,
    });
  }

  const issues = validateLocalPluginManifest(manifest);
  if (issues.length > 0) {
    throw new LocalPluginPolicyError({
      code: "manifest-invalid",
      message: issues.map((issue) => issue.message).join(" "),
      issues,
    });
  }

  return manifest;
}
