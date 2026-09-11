#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

export class ReleaseChangelogReadError extends Schema.TaggedErrorClass<ReleaseChangelogReadError>()(
  "ReleaseChangelogReadError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the release changelog '${this.filePath}'.`;
  }
}

export class ReleaseChangelogGitHubOutputConfigError extends Schema.TaggedErrorClass<ReleaseChangelogGitHubOutputConfigError>()(
  "ReleaseChangelogGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve the GITHUB_OUTPUT path for the release changelog body.";
  }
}

export class ReleaseChangelogGitHubOutputWriteError extends Schema.TaggedErrorClass<ReleaseChangelogGitHubOutputWriteError>()(
  "ReleaseChangelogGitHubOutputWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append the release changelog body to '${this.filePath}'.`;
  }
}

/**
 * Extract the `## <version>` section from a Keep-a-Changelog-style markdown
 * file. The section runs until the next `## ` heading (deeper `###` headings
 * stay inside). Returns "" when the file has no section for the version, so
 * releases can fall back to GitHub's generated notes.
 */
export function extractReleaseChangelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const heading = `## ${version}`;
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) return "";

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || /^##\s/.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n").trim();
}

export const writeReleaseChangelogOutput = Effect.fn("writeReleaseChangelogOutput")(function* (
  body: string,
  writeGithubOutput: boolean,
) {
  if (body === "") return;

  if (!writeGithubOutput) {
    yield* Effect.sync(() => process.stdout.write(`${body}\n`));
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new ReleaseChangelogGitHubOutputConfigError({ cause })),
  );
  const entry = `body<<CHANGELOG_BODY_EOF\n${body}\nCHANGELOG_BODY_EOF\n`;
  yield* fs
    .writeFileString(githubOutputPath, entry, { flag: "a" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseChangelogGitHubOutputWriteError({ filePath: githubOutputPath, cause }),
      ),
    );
});

const command = Command.make(
  "extract-release-changelog",
  {
    version: Flag.string("version").pipe(
      Flag.withDescription("Release version (without the leading v) whose section to extract."),
    ),
    changelog: Flag.string("changelog").pipe(
      Flag.withDescription("Path to CHANGELOG.md."),
      Flag.withDefault("CHANGELOG.md"),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write the section to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ version, changelog, githubOutput }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs
        .readFileString(changelog, "utf-8")
        .pipe(
          Effect.mapError((cause) => new ReleaseChangelogReadError({ filePath: changelog, cause })),
        );
      yield* writeReleaseChangelogOutput(
        extractReleaseChangelogSection(contents, version),
        githubOutput,
      );
    }),
).pipe(
  Command.withDescription("Extract a release's changelog section for the GitHub Release body."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
