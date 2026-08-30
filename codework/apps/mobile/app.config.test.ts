import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const repoEnvMock = vi.hoisted(() => ({
  current: {} as Record<string, string | undefined>,
}));

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => repoEnvMock.current,
}));

const CONFIG_ENV_NAMES = [
  "CODEWORK_IOS_PERSONAL_TEAM",
  "CODEWORK_IOS_PERSONAL_TEAM_BUNDLE_ID",
  "T3CODE_IOS_PERSONAL_TEAM",
  "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
] as const;

const loadConfig = async (env: Record<string, string | undefined>) => {
  repoEnvMock.current = { APP_VARIANT: "production", ...env };
  vi.resetModules();
  return (await import("./app.config.ts")).default;
};

afterEach(() => {
  repoEnvMock.current = {};
  for (const name of CONFIG_ENV_NAMES) delete process.env[name];
});

describe("iOS 个人团队配置", () => {
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
