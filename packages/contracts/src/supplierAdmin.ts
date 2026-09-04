/**
 * Supplier management operation contracts.
 *
 * Focused mutations on top of the provider-instance settings map: toggling an
 * instance on/off and rotating stored credentials. Requests carry the new
 * credential value inbound (like the existing full-settings patch path), but
 * results and errors only ever name the credential's *location* — the value
 * itself never round-trips back to any client, projection, or error message.
 *
 * @module supplierAdmin
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironmentVariableName, ProviderInstanceId } from "./providerInstance.ts";

/** 启用/禁用一个 Provider 实例（Supplier 条目）。 */
export const SupplierInstanceEnabledRequest = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type SupplierInstanceEnabledRequest = typeof SupplierInstanceEnabledRequest.Type;

export const SupplierInstanceEnabledResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type SupplierInstanceEnabledResult = typeof SupplierInstanceEnabledResult.Type;

/**
 * Credential rotation payload. Exactly one target kind:
 * - `byok_adapter`: rotate a BYOK adapter's API key and/or balance token.
 * - `environment_variable`: rotate a sensitive instance environment variable.
 */
export const SupplierCredentialUpdate = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("byok_adapter"),
    adapterId: TrimmedNonEmptyString,
    apiKey: Schema.optional(Schema.String),
    balanceAccessToken: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment_variable"),
    name: ProviderInstanceEnvironmentVariableName,
    value: Schema.String,
  }),
]);
export type SupplierCredentialUpdate = typeof SupplierCredentialUpdate.Type;

export const SupplierCredentialUpdateRequest = Schema.Struct({
  instanceId: ProviderInstanceId,
  credential: SupplierCredentialUpdate,
});
export type SupplierCredentialUpdateRequest = typeof SupplierCredentialUpdateRequest.Type;

/** 只回凭据定位信息（实例/目标/字段名），绝不回显凭据值。 */
export const SupplierCredentialUpdateResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  kind: Schema.Literals(["byok_adapter", "environment_variable"]),
  /** adapterId or environment variable name — never a secret. */
  target: TrimmedNonEmptyString,
  updatedFields: Schema.Array(TrimmedNonEmptyString),
});
export type SupplierCredentialUpdateResult = typeof SupplierCredentialUpdateResult.Type;

export const SupplierAdminErrorCode = Schema.Literals([
  "supplier_instance_not_found",
  "supplier_adapter_not_found",
  "supplier_environment_variable_not_found",
  "supplier_credential_not_supported",
  "supplier_credential_empty",
]);
export type SupplierAdminErrorCode = typeof SupplierAdminErrorCode.Type;

/** Supplier 管理操作失败的稳定传输形状；detail 只含定位信息，不含凭据值。 */
export class SupplierAdminRpcError extends Schema.TaggedErrorClass<SupplierAdminRpcError>()(
  "SupplierAdminRpcError",
  {
    code: SupplierAdminErrorCode,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Supplier 管理操作失败：${this.code}: ${this.detail}`;
  }
}
