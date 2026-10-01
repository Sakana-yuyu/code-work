import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { normalizeAuthMethodIdentity } from "../scripts/authMethodCompatibility.ts";
import * as AcpSchema from "./schema.ts";

const decodeEnvVar = Schema.decodeUnknownSync(AcpSchema.AuthMethodEnvVar);
const decodeTerminal = Schema.decodeUnknownSync(AcpSchema.AuthMethodTerminal);
const decodeAgent = Schema.decodeUnknownSync(AcpSchema.AuthMethodAgent);
const decodeAuthMethod = Schema.decodeUnknownSync(AcpSchema.AuthMethod);

describe("认证方法兼容合同", () => {
  it("类型和解码均允许身份缺省，非法类型与其它必填字段仍拒绝", () => {
    const env: AcpSchema.AuthMethodEnvVar = { vars: [] };
    const terminal: AcpSchema.AuthMethodTerminal = {};
    const agent: AcpSchema.AuthMethodAgent = {};
    expect(decodeEnvVar(env)).toEqual(env);
    expect(decodeTerminal(terminal)).toEqual(terminal);
    expect(decodeAgent(agent)).toEqual(agent);
    expect(decodeAuthMethod({ type: "env_var", vars: [] })).toMatchObject(env);
    expect(decodeAuthMethod({ type: "terminal" })).toMatchObject({ type: "terminal" });
    expect(decodeAuthMethod({})).toEqual({});
    expect(() => decodeAuthMethod({ id: 123 })).toThrow();
    expect(() => decodeAuthMethod({ name: false })).toThrow();
    expect(() => decodeEnvVar({})).toThrow();
  });

  it("生成过程保留身份兼容，嵌套字段和其它必填条件不变", () => {
    const original = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        vars: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
      required: ["id", "name", "vars"],
    } satisfies Schema.Json;
    const compatible = normalizeAuthMethodIdentity(original);
    expect(compatible).toMatchObject({ required: ["vars"], properties: original.properties });
    expect(original.required).toEqual(["id", "name", "vars"]);
    expect(normalizeAuthMethodIdentity({ oneOf: [original] })).toEqual({ oneOf: [compatible] });
    const generator = makeJsonSchemaGenerator();
    generator.addSchema("AuthMethodEnvVar", compatible as never);
    const output = generator.generate(
      "openapi-3.1",
      { AuthMethodEnvVar: compatible } as never,
      false,
    );
    expect(output).toContain('readonly "id"?: string');
    expect(output).toContain('readonly "name"?: string');
    expect(output).toContain('readonly "vars":');
    expect(output).toContain('readonly "name": string');
  });
});
