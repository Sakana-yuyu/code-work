// @effect-diagnostics nodeBuiltinImport:off
import { CanvasCreateInput, ProjectWriteFileInput } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { listCanvasArtifacts, writeCanvasArtifact } from "./CanvasArtifact.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const authCanvasRequest = Schema.decodeUnknownSync(CanvasCreateInput)({
  cwd: "E:/workspace",
  canvasId: "auth.canvas",
  title: "Auth analysis",
  blocks: [
    { type: "stat", label: "Files", value: "3" },
    { type: "file", path: "apps/server/src/server.ts", line: 1 },
  ],
});

describe("writeCanvasArtifact", () => {
  it("rejects empty Canvas content at the input boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(CanvasCreateInput)({
        cwd: "E:/workspace",
        title: "Empty analysis",
        blocks: [],
      }),
    ).toThrow();
  });

  it.effect("writes a safe, durable structured Canvas artifact", () =>
    Effect.gen(function* () {
      let written: ProjectWriteFileInput | undefined;

      const reference = yield* writeCanvasArtifact({
        fileSystem: {
          writeFile: (input) => {
            written = input;
            return Effect.succeed({ relativePath: input.relativePath });
          },
        },
        request: authCanvasRequest,
        threadId: "thread/one",
        fallbackCanvasId: "tool-call",
        now: 123,
      });

      expect(reference).toEqual({
        canvasId: "auth-canvas",
        title: "Auth analysis",
        relativePath: ".codework/canvases/thread-one/Auth-analysis.canvas.json",
      });
      expect(written).toBeDefined();
      expect(written?.relativePath).toBe(reference.relativePath);
      expect(decodeJson(written?.contents ?? "")).toMatchObject({
        schemaVersion: 1,
        canvasId: "auth-canvas",
        createdAt: 123,
        updatedAt: 123,
      });
    }),
  );
});

describe("listCanvasArtifacts", () => {
  const workspacePaths = {
    normalizeWorkspaceRoot: (cwd: string) => Effect.succeed(cwd),
  };
  let root = "";
  const created: string[] = [];

  const writeFile = async (relativePath: string, contents: string) => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents, "utf8");
    created.push(absolutePath);
  };

  beforeAll(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-canvas-list-"));
  });

  afterAll(async () => {
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it.effect("lists artifacts across thread directories, newest first", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(
          ".codework/canvases/thread-a/old.canvas.json",
          encodeJson({
            schemaVersion: 1,
            canvasId: "old",
            title: "Old",
            blocks: [{ type: "section", heading: "h", body: "b" }],
            relativePath: ".codework/canvases/thread-a/old.canvas.json",
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          ".codework/canvases/thread-b/new.canvas.json",
          encodeJson({
            schemaVersion: 1,
            canvasId: "new",
            title: "New",
            blocks: [{ type: "section", heading: "h", body: "b" }],
            relativePath: ".codework/canvases/thread-b/new.canvas.json",
            createdAt: 2,
            updatedAt: 2,
          }),
        ),
      );

      const canvases = yield* listCanvasArtifacts({ workspacePaths, cwd: root });

      expect(canvases.map((canvas) => canvas.canvasId)).toEqual(["new", "old"]);
    }),
  );

  it.effect("skips invalid artifacts and unrelated files without failing", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(".codework/canvases/thread-a/broken.canvas.json", "{ not json"),
      );
      yield* Effect.promise(() => writeFile(".codework/canvases/thread-a/notes.txt", "ignore me"));
      yield* Effect.promise(() =>
        writeFile("src/not-a-canvas.json", encodeJson({ canvasId: "nope" })),
      );

      const canvases = yield* listCanvasArtifacts({ workspacePaths, cwd: root });

      expect(canvases.map((canvas) => canvas.canvasId)).toEqual(["new", "old"]);
    }),
  );

  it.effect("returns an empty listing when the canvases directory does not exist", () =>
    Effect.gen(function* () {
      const canvases = yield* listCanvasArtifacts({
        workspacePaths,
        cwd: NodePath.join(root, "missing-workspace"),
      });

      expect(canvases).toEqual([]);
    }),
  );
});
