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
    throw new LocalPluginPolicyError({
      code: "schema-invalid",
      message: "插件 manifest 不符合受支持的 schema。",
    });
  }

  const compatibility = negotiateLocalPluginApiVersion(manifest.apiVersion);
  if (!compatibility.compatible) {
    throw new LocalPluginPolicyError({
      code: "api-incompatible",
      message: "插件 contribution API 与当前宿主不兼容。",
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
