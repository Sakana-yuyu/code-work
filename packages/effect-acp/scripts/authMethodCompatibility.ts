import type * as Schema from "effect/Schema";

// 只兼容认证方法的身份缺省，保留字段类型和其它必填条件。
export function normalizeAuthMethodIdentity(schema: Schema.Json): Schema.Json {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "required" && Array.isArray(value)
        ? value.filter((field) => field !== "id" && field !== "name")
        : (key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)
          ? value.map(normalizeAuthMethodIdentity)
          : value,
    ]),
  );
}
