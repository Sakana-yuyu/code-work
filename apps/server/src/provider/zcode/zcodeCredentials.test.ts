// @effect-diagnostics preferSchemaOverJson:off - 测试构造 ZCode 凭据 JSON。
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { parseLocalCredential } from "../LocalAccountPool.ts";
import {
  decryptZCodeCredentialRecord,
  decryptZCodeValue,
  normalizeZCodePoolCredential,
  zcodeAccountEmail,
  zcodeAccountLabel,
  zcodeFamilyOf,
  zcodePlanApiKey,
  ZCodeCredentialError,
  ZCODE_PLAN_GATEWAY_ANTHROPIC_BASE,
} from "./zcodeCredentials.ts";

const TEST_ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };

/** 用与 ZCode 相同的算法制造 `enc:v1:` 密文（sha256(secret) → aes-256-gcm）。 */
const encrypt = (value: string): string => {
  const key = NodeCrypto.createHash("sha256").update("test-secret").digest();
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
};

const credentialRecord = (overrides: Record<string, string> = {}) => ({
  "oauth:active_provider": encrypt("zai"),
  "oauth:zai:access_token": encrypt("oauth-access"),
  "oauth:zai:refresh_token": encrypt("oauth-refresh"),
  "oauth:zai:user_info": encrypt(
    JSON.stringify({ user_id: "u-1", email: "dev@z.ai", name: "Dev" }),
  ),
  zcodejwttoken: encrypt("jwt-token"),
  "account-provider:account:zai-individual-coding-plan:identity": encrypt("u-1"),
  "account-provider:coding-plan:account:zai-individual-coding-plan:account:u-1:api-key":
    encrypt("plan-api-key"),
  ...overrides,
});

describe("ZCode 凭据", () => {
  it("解密 enc:v1 值并原样放行明文", () => {
    expect(decryptZCodeValue(encrypt("hello"), TEST_ENV)).toBe("hello");
    expect(decryptZCodeValue("plain-text", TEST_ENV)).toBe("plain-text");
    expect(() => decryptZCodeValue("enc:v1:bad.parts", TEST_ENV)).toThrow(ZCodeCredentialError);
    expect(() => decryptZCodeValue(encrypt("x") + "tamper", TEST_ENV)).toThrow(
      ZCodeCredentialError,
    );
    // 错误密钥（未设置 ZCODE_CREDENTIAL_SECRET 的其它环境）解不开。
    expect(() => decryptZCodeValue(encrypt("x"), { ZCODE_CREDENTIAL_SECRET: "other" })).toThrow(
      ZCodeCredentialError,
    );
  });

  it("解密整个凭据记录并按 active_provider 选择 Coding Plan API Key", () => {
    const record = decryptZCodeCredentialRecord(
      credentialRecord({
        "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:b-2:api-key":
          encrypt("bigmodel-key"),
      }),
      TEST_ENV,
    );
    expect(zcodeFamilyOf(record)).toBe("zai");
    expect(zcodePlanApiKey(record)).toBe("plan-api-key");
    expect(zcodeAccountLabel(record)).toBe("Dev");
    expect(zcodeAccountEmail(record)).toBe("dev@z.ai");
  });

  it("归一化为号池凭据：只留 API Key 与路由元数据", () => {
    const record = decryptZCodeCredentialRecord(credentialRecord(), TEST_ENV);
    expect(normalizeZCodePoolCredential(record)).toEqual({
      api_key: "plan-api-key",
      auth_kind: "api-key",
      zcode_family: "zai",
      zcode_jwt: "jwt-token",
      account_label: "Dev",
      account_email: "dev@z.ai",
    });
    expect(normalizeZCodePoolCredential({ "oauth:zai:access_token": "x" })).toBeUndefined();
  });

  it("只有体验套餐（zcodejwttoken）没有 Coding Plan Key 的凭据也放行", () => {
    const API_KEY_ENTRY =
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:u-1:api-key";
    const full = decryptZCodeCredentialRecord(credentialRecord(), TEST_ENV);
    const record: Record<string, string> = Object.fromEntries(
      Object.entries(full).filter(([key]) => key !== API_KEY_ENTRY),
    );
    const normalized = normalizeZCodePoolCredential(record);
    expect(normalized).not.toBeNull();
    expect(normalized!.api_key).toBeUndefined();
    expect(normalized!.zcode_jwt).toBe("jwt-token");
    expect(normalized!.zcode_family).toBe("zai");
    // parseLocalCredential 直通池内归一化结果（JWT-only）。
    expect(
      parseLocalCredential(
        JSON.stringify({ zcode_jwt: "jwt-token", zcode_family: "zai" }),
        "zcode",
      ),
    ).toMatchObject({ zcode_jwt: "jwt-token" });
  });

  it("parseLocalCredential 走解密路径并产出 api-key 凭据", () => {
    // 未加密条目按明文放行（与 ZCode cipher 行为一致），可直接构造明文 fixture。
    const plain = Object.fromEntries(
      Object.entries(credentialRecord()).map(([key]) => [
        key,
        key.endsWith(":api-key")
          ? "plan-api-key"
          : key === "oauth:active_provider"
            ? "zai"
            : key === "oauth:zai:user_info"
              ? JSON.stringify({ user_id: "u-1", name: "Dev" })
              : "plain",
      ]),
    );
    expect(parseLocalCredential(JSON.stringify(plain), "zcode")).toMatchObject({
      api_key: "plan-api-key",
      auth_kind: "api-key",
      zcode_family: "zai",
      account_label: "Dev",
    });
    expect(() => parseLocalCredential(JSON.stringify(credentialRecord()), "zcode")).toThrow(
      /解密失败/u,
    );
    expect(() => parseLocalCredential(JSON.stringify({ foo: "bar" }), "zcode")).toThrow(/API Key/u);
  });

  it("号池上游按 family 取平台网关", () => {
    expect(ZCODE_PLAN_GATEWAY_ANTHROPIC_BASE.zai).toBe(
      "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
    );
    expect(ZCODE_PLAN_GATEWAY_ANTHROPIC_BASE.bigmodel).toBe(
      "https://zcode.z.ai/api/v1/ultra/anthropic",
    );
  });
});
