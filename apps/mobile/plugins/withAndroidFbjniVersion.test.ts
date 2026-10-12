import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { compileModsAsync, type ConfigPlugin } from "expo/config-plugins";

const require = NodeModule.createRequire(import.meta.url);
const withAndroidFbjniVersion: ConfigPlugin = require("./withAndroidFbjniVersion.cjs");
const fixtures: string[] = [];
const originalGradle = "// 保留已有工程配置\nbuildscript { repositories { google() } }\n";

const createFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-fbjni-test-"));
  fixtures.push(root);
  const packageRoot = NodePath.join(root, "node_modules/react-native");
  NodeFS.mkdirSync(NodePath.join(packageRoot, "gradle"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "android"));
  NodeFS.writeFileSync(
    NodePath.join(packageRoot, "package.json"),
    JSON.stringify({ name: "react-native" }),
  );
  const build = NodePath.join(root, "android/build.gradle");
  const versions = NodePath.join(packageRoot, "gradle/libs.versions.toml");
  NodeFS.writeFileSync(build, originalGradle);
  NodeFS.writeFileSync(versions, 'fbjni = "0.7.0"\n');
  return {
    build,
    versions,
    readBuild: () => NodeFS.readFileSync(build, "utf8"),
    apply: () =>
      compileModsAsync(withAndroidFbjniVersion({ name: "原生构建验收", slug: "fbjni-test" }), {
        projectRoot: root,
        platforms: ["android"],
      }),
  };
};

afterEach(() => {
  for (const root of fixtures.splice(0)) NodeFS.rmSync(root, { recursive: true });
});

describe("Android fbjni 与 React Native 原生运行库配套", () => {
  it("通过真实 Expo mod 流水线读取当前 RN 版本并保留已有配置", async () => {
    const fixture = createFixture();
    await fixture.apply();
    expect(fixture.readBuild()).toContain("com.facebook.fbjni:fbjni:0.7.0");
    expect(fixture.readBuild().startsWith(originalGradle)).toBe(true);
  });

  it("重复 prebuild 不追加重复配置块", async () => {
    const fixture = createFixture();
    await fixture.apply();
    const first = fixture.readBuild();
    await fixture.apply();
    expect(fixture.readBuild()).toBe(first);
  });

  it("RN 升级后替换约束而非永久固定旧版本", async () => {
    const fixture = createFixture();
    await fixture.apply();
    NodeFS.writeFileSync(fixture.versions, 'fbjni = "0.8.1"\n');
    await fixture.apply();
    const updated = fixture.readBuild();
    expect(updated).toContain("com.facebook.fbjni:fbjni:0.8.1");
    expect(updated).not.toContain("fbjni:0.7.0");
    expect(updated.match(/codework-fbjni-version:start/g)).toHaveLength(1);
  });

  it("无法读取版本时停止生成并保留工程文件", async () => {
    const fixture = createFixture();
    NodeFS.writeFileSync(fixture.versions, 'fbjni = { unexpected = "未知结构" }\n');
    await expect(fixture.apply()).rejects.toThrow("无法从当前 React Native 版本清单读取 fbjni");
    expect(fixture.readBuild()).toBe(originalGradle);
  });

  it("已有配置块不完整时拒绝继续追加", async () => {
    const fixture = createFixture();
    const broken = `${originalGradle}// codework-fbjni-version:start\n`;
    NodeFS.writeFileSync(fixture.build, broken);
    await expect(fixture.apply()).rejects.toThrow("已有 fbjni 生成块不完整");
    expect(fixture.readBuild()).toBe(broken);
  });
});
