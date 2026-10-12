const fs = require("node:fs");
const path = require("node:path");
const { withProjectBuildGradle } = require("expo/config-plugins");

const START = "// codework-fbjni-version:start";
const END = "// codework-fbjni-version:end";

module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("fbjni 版本约束需要 Expo 的 Groovy Android 构建模板。");
    }
    const reactNativePackage = require.resolve("react-native/package.json", {
      paths: [nextConfig.modRequest.projectRoot],
    });
    const versions = fs.readFileSync(
      path.join(path.dirname(reactNativePackage), "gradle/libs.versions.toml"),
      "utf8",
    );
    const version = versions.match(/^fbjni\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
    if (!version)
      throw new Error("无法从当前 React Native 版本清单读取 fbjni，拒绝生成不匹配的构建。");

    // 高亮依赖的 fbjni:+ 会浮动到不同 NDK 构建的库；始终与当前 RN 的原生运行库配套。
    const block = `${START}
allprojects {
    configurations.configureEach {
        resolutionStrategy.force 'com.facebook.fbjni:fbjni:${version}'
    }
}
${END}`;
    const { contents } = nextConfig.modResults;
    const start = contents.indexOf(START);
    const end = contents.indexOf(END, start);
    if (start >= 0 && end < start)
      throw new Error("已有 fbjni 生成块不完整，请重新生成 Android 项目。");
    nextConfig.modResults.contents =
      start < 0
        ? `${contents.trimEnd()}\n\n${block}\n`
        : `${contents.slice(0, start)}${block}${contents.slice(end + END.length)}`;
    return nextConfig;
  });
};
