// @effect-diagnostics preferSchemaOverJson:off - 测试构造 ZCode 登录响应 JSON。
// @effect-diagnostics nodeBuiltinImport:off - 测试用临时目录直接读写凭据文件。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  decryptZCodeCredentialRecord,
  decryptZCodeValue,
  normalizeZCodePoolCredential,
  zcodeAccountLabel,
  zcodeFamilyOf,
  zcodePlanApiKey,
} from "./zcodeCredentials.ts";
import { writeZCodeLoginCredentials, type ZCodeLoginReadyResult } from "./zcodeLoginFlow.ts";

const TEST_ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };

const makeTempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-login-flow-"));

const READY_ZAI: ZCodeLoginReadyResult = {
  userId: "u-1",
  email: "dev@z.ai",
  name: "Dev",
  avatar: "https://example.test/a.png",
  accessToken: "oauth-access",
  refreshToken: "oauth-refresh",
  jwtToken: "jwt-token",
};

const READY_BIGMODEL: ZCodeLoginReadyResult = {
  userId: "b-2",
  name: "国内用户",
  accessToken: "bigmodel-access",
  refreshToken: "bigmodel-refresh",
  jwtToken: "bigmodel-jwt",
};

describe("ZCode 登录凭据写入", () => {
  it.layer(NodeServices.layer)("writeZCodeLoginCredentials", (it) => {
    it.effect("zai：写 enc:v1 凭据，账号名/plan key/active_provider 均可读回", () =>
      Effect.gen(function* () {
        const home = makeTempDir();
        const filePath = yield* writeZCodeLoginCredentials({
          dataBaseDir: home,
          family: "zai",
          ready: READY_ZAI,
          apiKey: "plan-api-key",
          env: TEST_ENV,
        });
        expect(filePath).toBe(NodePath.join(home, ".zcode", "v2", "credentials.json"));
        const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, string>;
        // 上游格式：全部值都是 enc:v1 加密串。
        expect(Object.values(raw).every((v) => v.startsWith("enc:v1:"))).toBe(true);
        const record = decryptZCodeCredentialRecord(raw, TEST_ENV);
        expect(zcodeFamilyOf(record)).toBe("zai");
        expect(zcodePlanApiKey(record)).toBe("plan-api-key");
        expect(zcodeAccountLabel(record)).toBe("Dev");
        expect(record["oauth:zai:access_token"]).toBe("oauth-access");
        expect(record["zcodejwttoken"]).toBe("jwt-token");
        // 号池归一化：读出 api_key 并按 z.ai 网关族归类。
        const normalized = normalizeZCodePoolCredential(record);
        expect(normalized).not.toBeNull();
        expect(normalized!.api_key).toBe("plan-api-key");
        expect(normalized!.zcode_family).toBe("zai");
      }),
    );

    it.effect("bigmodel：user_info 为 {id,username,displayName,rawProfile} 形状", () =>
      Effect.gen(function* () {
        const home = makeTempDir();
        const filePath = yield* writeZCodeLoginCredentials({
          dataBaseDir: home,
          family: "bigmodel",
          ready: READY_BIGMODEL,
          apiKey: "bigmodel-key",
          env: TEST_ENV,
        });
        const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, string>;
        const info = JSON.parse(
          decryptZCodeValue(raw["oauth:bigmodel:user_info"]!, TEST_ENV),
        ) as Record<string, unknown>;
        expect(info.id).toBe("b-2");
        expect(info.username).toBe("国内用户");
        expect(info.displayName).toBe("国内用户");
        const record = decryptZCodeCredentialRecord(raw, TEST_ENV);
        expect(zcodeFamilyOf(record)).toBe("bigmodel");
        expect(zcodePlanApiKey(record)).toBe("bigmodel-key");
        expect(normalizeZCodePoolCredential(record)?.zcode_family).toBe("bigmodel");
      }),
    );

    it.effect("已有凭据不被丢弃：保留其他 key，覆盖同 key", () =>
      Effect.gen(function* () {
        const home = makeTempDir();
        const dir = NodePath.join(home, ".zcode", "v2");
        NodeFS.mkdirSync(dir, { recursive: true });
        const fs = yield* FileSystem.FileSystem;
        // 预置一条与登录无关的既有 key。
        const kept = `enc:v1:${NodeCrypto.randomBytes(12).toString("base64url")}.x.y`;
        void fs;
        NodeFS.writeFileSync(
          NodePath.join(dir, "credentials.json"),
          JSON.stringify({ "oauth:custom": kept }),
        );
        yield* writeZCodeLoginCredentials({
          dataBaseDir: home,
          family: "zai",
          ready: READY_ZAI,
          apiKey: "k",
          env: TEST_ENV,
        });
        const raw = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, "credentials.json"), "utf8"),
        ) as Record<string, string>;
        expect(raw["oauth:custom"]).toBe(kept);
      }),
    );
  });
});
