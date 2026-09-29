// @effect-diagnostics nodeBuiltinImport:off - 纯路径计算，与 grokHome 同一模式。
/**
 * 号池「登录添加账号」：官方 CLI 在一次性目录里完成登录，登录结束后读取该目录的
 * 凭据文件导入号池，再删除目录。这样同一台机器可以连续登多个账号，
 * 也不会碰到用户自己的 ~/.codex、~/.claude、~/.grok 登录态。
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { LocalAccountProvider, ServerSettings } from "@codework/contracts";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveGrokHome } from "./grokHome.ts";
import { resolveZCodeDataDir } from "./zcode/zcodeByokConfig.ts";
import {
  decryptZCodeCredentialRecord,
  zcodeAccountEmail,
  zcodeAccountLabel,
} from "./zcode/zcodeCredentials.ts";

export type LocalPoolLoginProvider = Extract<
  LocalAccountProvider,
  "codex" | "claude" | "xai" | "zcode"
>;

export const LOCAL_POOL_LOGIN_TERMINAL_ID = /^[a-zA-Z0-9-]{1,80}$/;

export function localPoolLoginHome(stateDir: string, terminalId: string): string {
  return NodePath.join(stateDir, "local-pool-logins", terminalId);
}

/**
 * 各 CLI 在 home 目录里落凭据的文件（相对路径）；macOS 钥匙串登录态不落文件，无法导入。
 * ZCode 的 home 是 `ZCODE_DATA_BASE_DIR`，凭据固定在其下的 `.zcode/v2/credentials.json`。
 */
export const LOCAL_POOL_LOGIN_CREDENTIAL_FILE: Record<LocalPoolLoginProvider, string> = {
  codex: "auth.json",
  claude: ".credentials.json",
  xai: "auth.json",
  zcode: ".zcode/v2/credentials.json",
};

/** 登录用的 home 环境变量名。 */
export const LOCAL_POOL_LOGIN_HOME_ENV: Record<LocalPoolLoginProvider, string> = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  xai: "GROK_HOME",
  zcode: "ZCODE_DATA_BASE_DIR",
};

export const isLocalPoolLoginProvider = (
  provider: LocalAccountProvider,
): provider is LocalPoolLoginProvider =>
  provider === "codex" || provider === "claude" || provider === "xai" || provider === "zcode";

/** 号池「从本机导入」扫描到的原生凭据落点。 */
export interface LocalNativeLoginCandidate {
  readonly provider: LocalPoolLoginProvider;
  readonly path: string;
  /** 凭据里能解析出的账号名/邮箱（供列表展示与自动导入）。 */
  readonly label?: string | undefined;
}

const envValue = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value === undefined || value === "" ? undefined : expandHomePath(value);
};

const tryPath = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : NodePath.resolve(expandHomePath(text));
};

const instanceConfigRecord = (config: unknown): Record<string, string | undefined> => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  const record = config as Record<string, unknown>;
  return {
    homePath: typeof record.homePath === "string" ? record.homePath : undefined,
    shadowHomePath: typeof record.shadowHomePath === "string" ? record.shadowHomePath : undefined,
  };
};

/**
 * 全量候选：默认个人目录 + 各实例的受管 home。去重靠 path.resolve 后的字符串。
 * zcode 额外扫旧布局 `~/.zcode/credentials.json`（ZCode 桌面端写在这里）。
 */
export const nativeLoginCandidatePaths = (input: {
  readonly stateDir: string;
  readonly settings: ServerSettings;
}): ReadonlyArray<{ provider: LocalPoolLoginProvider; path: string }> => {
  const home = NodeOS.homedir();
  const candidates: Array<{ provider: LocalPoolLoginProvider; path: string }> = [];
  const seen = new Set<string>();
  const push = (provider: LocalPoolLoginProvider, path: string | undefined) => {
    if (path === undefined) return;
    const resolved = NodePath.resolve(path);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push({ provider, path: resolved });
  };

  // 默认个人目录。
  push("codex", NodePath.join(envValue("CODEX_HOME") ?? `${home}/.codex`, "auth.json"));
  push(
    "claude",
    NodePath.join(envValue("CLAUDE_CONFIG_DIR") ?? `${home}/.claude`, ".credentials.json"),
  );
  push("xai", NodePath.join(envValue("GROK_HOME") ?? `${home}/.grok`, "auth.json"));
  push(
    "zcode",
    NodePath.join(envValue("ZCODE_DATA_BASE_DIR") ?? `${home}/.zcode`, "v2", "credentials.json"),
  );
  // ZCode 桌面端（非 CLI 数据根）的旧布局：`~/.zcode/credentials.json`。
  push("zcode", NodePath.join(home, ".zcode", "credentials.json"));

  // 各实例的受管 home（我们在供应商卡里登录写的就是这些位置）。
  for (const [instanceId, entry] of Object.entries(input.settings.providerInstances)) {
    const config = instanceConfigRecord(entry?.config);
    switch (entry?.driver) {
      case "codex": {
        const home = tryPath(config.shadowHomePath) ?? tryPath(config.homePath);
        if (home !== undefined) push("codex", NodePath.join(home, "auth.json"));
        break;
      }
      case "claudeAgent": {
        const home = tryPath(config.homePath);
        if (home !== undefined) push("claude", NodePath.join(home, ".credentials.json"));
        break;
      }
      case "grok": {
        push(
          "xai",
          NodePath.join(
            resolveGrokHome({ stateDir: input.stateDir, instanceId, routed: false }),
            "auth.json",
          ),
        );
        break;
      }
      case "zcodeAgent": {
        push(
          "zcode",
          NodePath.join(
            resolveZCodeDataDir({ stateDir: input.stateDir, instanceId }),
            "v2",
            "credentials.json",
          ),
        );
        break;
      }
    }
  }
  // legacy providers 对象（未迁移出实例的旧配置）。
  const legacy = input.settings.providers;
  const codexLegacy = instanceConfigRecord(legacy?.codex);
  const codexLegacyHome = tryPath(codexLegacy.shadowHomePath) ?? tryPath(codexLegacy.homePath);
  if (codexLegacyHome !== undefined) push("codex", NodePath.join(codexLegacyHome, "auth.json"));
  const claudeLegacyHome = tryPath(instanceConfigRecord(legacy?.claudeAgent).homePath);
  if (claudeLegacyHome !== undefined)
    push("claude", NodePath.join(claudeLegacyHome, ".credentials.json"));
  return candidates;
};

/** 从凭据内容里尽力提取账号展示名；失败返回 undefined（调用方退回文件名）。 */
export const nativeLoginLabel = (
  provider: LocalPoolLoginProvider,
  content: string,
): string | undefined => {
  try {
    const record = JSON.parse(content) as Record<string, unknown>;
    if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
    if (provider === "zcode") {
      // zcode 凭据是加密的；解不开（跨机器）就退 undefined。
      try {
        const decrypted = decryptZCodeCredentialRecord(record as Record<string, unknown>);
        return zcodeAccountLabel(decrypted) ?? zcodeAccountEmail(decrypted);
      } catch {
        return undefined;
      }
    }
    if (provider === "codex") {
      const tokens = record.tokens as Record<string, unknown> | undefined;
      const idToken =
        typeof tokens?.id_token === "string"
          ? tokens.id_token
          : typeof record.id_token === "string"
            ? record.id_token
            : undefined;
      if (idToken !== undefined) {
        const parts = idToken.split(".");
        if (parts.length >= 2) {
          try {
            const payload = JSON.parse(
              Buffer.from(parts[1]!, "base64url").toString("utf8"),
            ) as Record<string, unknown>;
            const label = [payload.email, payload.name, payload.preferred_username].find(
              (v): v is string => typeof v === "string" && v.trim().length > 0,
            );
            if (label !== undefined) return label.trim();
          } catch {
            // JWT 解析失败继续看顶层字段。
          }
        }
      }
    }
    for (const key of ["email", "name", "username", "account_label", "accountName"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    const nested =
      (record.claudeAiOauth as Record<string, unknown> | undefined) ??
      (record.tokens as Record<string, unknown> | undefined) ??
      Object.values(record).find(
        (v): v is Record<string, unknown> =>
          v !== null && typeof v === "object" && !Array.isArray(v),
      );
    if (nested !== undefined) {
      for (const key of ["email", "name", "username", "emailAddress"]) {
        const value = nested[key];
        if (typeof value === "string" && value.trim().length > 0) return value.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};
