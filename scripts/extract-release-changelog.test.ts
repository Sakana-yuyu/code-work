import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  extractReleaseChangelogSection,
  writeReleaseChangelogOutput,
} from "./extract-release-changelog.ts";

const SAMPLE_CHANGELOG = `# 更新日志

说明文字，不属于任何版本。

## 1.0.5-battle

与 1.0.4 内容一致。

### 小节

- 条目一

## 1.0.4

### 新增

- 版本与下载页面

## 1.0.3

修复若干。
`;

describe("extractReleaseChangelogSection", () => {
  it("extracts the section for the exact version heading", () => {
    assert.equal(
      extractReleaseChangelogSection(SAMPLE_CHANGELOG, "1.0.4"),
      "### 新增\n\n- 版本与下载页面",
    );
  });

  it("keeps deeper headings inside the section and stops at the next h2", () => {
    assert.equal(
      extractReleaseChangelogSection(SAMPLE_CHANGELOG, "1.0.5-battle"),
      "与 1.0.4 内容一致。\n\n### 小节\n\n- 条目一",
    );
  });

  it("returns an empty string for unknown versions", () => {
    assert.equal(extractReleaseChangelogSection(SAMPLE_CHANGELOG, "1.0.3"), "修复若干。");
    assert.equal(extractReleaseChangelogSection(SAMPLE_CHANGELOG, "0.0.1"), "");
  });

  it("does not match versions embedded in longer headings", () => {
    const changelog = "## 1.0.4（测试线）\n\n内容\n";
    assert.equal(extractReleaseChangelogSection(changelog, "1.0.4"), "");
  });

  it("handles CRLF line endings", () => {
    const changelog = "## 1.0.4\r\n\r\n- 条目\r\n\r\n## 1.0.3\r\n\r\n旧\r\n";
    assert.equal(extractReleaseChangelogSection(changelog, "1.0.4"), "- 条目");
  });
});

describe("writeReleaseChangelogOutput", () => {
  it.effect("appends a heredoc entry to GITHUB_OUTPUT and skips empty bodies", () => {
    const writes: Array<{ path: string; data: string; flag?: unknown }> = [];

    return Effect.gen(function* () {
      yield* writeReleaseChangelogOutput("第一行\n\n第二行", true);
      yield* writeReleaseChangelogOutput("", true);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          writeFileString: (path, data, options) =>
            Effect.sync(() => {
              writes.push({ path, data: String(data), flag: (options as { flag?: string }).flag });
            }),
        }),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { GITHUB_OUTPUT: "/tmp/changelog-output" } }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const write = writes[0];
          assert.ok(write !== undefined);
          assert.equal(write.path, "/tmp/changelog-output");
          assert.equal(
            write.data,
            "body<<CHANGELOG_BODY_EOF\n第一行\n\n第二行\nCHANGELOG_BODY_EOF\n",
          );
          assert.equal(write.flag, "a");
        }),
      ),
    );
  });
});
