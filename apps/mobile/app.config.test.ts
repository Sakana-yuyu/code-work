import { describe, expect, it, vi } from "vite-plus/test";

const repoEnvMock = vi.hoisted(() => ({
  current: {} as Record<string, string | undefined>,
}));

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => repoEnvMock.current,
}));

const CONFIG_ENV_NAMES = [
  "APP_VARIANT",
  "CODEWORK_IOS_PERSONAL_TEAM",
  "CODEWORK_IOS_PERSONAL_TEAM_BUNDLE_ID",
  "T3CODE_IOS_PERSONAL_TEAM",
  "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
] as const;

const loadConfig = async (env: Record<string, string | undefined>) => {
  const previousEnv = new Map(CONFIG_ENV_NAMES.map((name) => [name, process.env[name]] as const));
  repoEnvMock.current = { APP_VARIANT: "production", ...env };
  vi.resetModules();
  try {
    return (await import("./app.config.ts")).default;
  } finally {
    repoEnvMock.current = {};
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

describe("iOS 个人团队配置", () => {
  it("加载配置后恢复调用前的进程环境", async () => {
    const previous = process.env.CODEWORK_IOS_PERSONAL_TEAM;
    process.env.CODEWORK_IOS_PERSONAL_TEAM = "调用前值";
    try {
      await loadConfig({
        CODEWORK_IOS_PERSONAL_TEAM: "1",
        CODEWORK_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.restore",
      });

      expect(process.env.CODEWORK_IOS_PERSONAL_TEAM).toBe("调用前值");
    } finally {
      if (previous === undefined) delete process.env.CODEWORK_IOS_PERSONAL_TEAM;
      else process.env.CODEWORK_IOS_PERSONAL_TEAM = previous;
    }
  });

  it("读取 canonical 环境变量", async () => {
    const config = await loadConfig({
      CODEWORK_IOS_PERSONAL_TEAM: "1",
      CODEWORK_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.canonical",
    });

    expect(config.ios?.bundleIdentifier).toBe("dev.codework.canonical");
    expect(config.extra?.iosPersonalTeamBuild).toBe(true);
  });

  it("仅设置 legacy 环境变量时仍启用个人团队构建", async () => {
    const config = await loadConfig({
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.legacy",
    });

    expect(config.ios?.bundleIdentifier).toBe("dev.codework.legacy");
    expect(config.extra?.iosPersonalTeamBuild).toBe(true);
  });

  it("canonical 环境变量优先于 legacy 环境变量", async () => {
    const config = await loadConfig({
      CODEWORK_IOS_PERSONAL_TEAM: "1",
      CODEWORK_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.canonical",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.legacy",
    });

    expect(config.ios?.bundleIdentifier).toBe("dev.codework.canonical");
    expect(config.extra?.iosPersonalTeamBuild).toBe(true);
  });

  it("canonical 禁用标志优先于 legacy 启用标志", async () => {
    const config = await loadConfig({
      CODEWORK_IOS_PERSONAL_TEAM: "0",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.codework.legacy",
    });

    expect(config.ios?.bundleIdentifier).toBe("com.codework.mobile");
    expect(config.extra?.iosPersonalTeamBuild).toBe(false);
  });
});
