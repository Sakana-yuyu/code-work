// @effect-diagnostics nodeBuiltinImport:off
import { CanvasCreateInput, ProjectWriteFileInput } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { listCanvasArtifacts, writeCanvasArtifact } from "./CanvasArtifact.ts";

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

  it("writes a safe, durable structured Canvas artifact", () => {
    const request = Schema.decodeUnknownSync(CanvasCreateInput)({
      cwd: "E:/workspace",
      canvasId: "auth.canvas",
      title: "Auth analysis",
      blocks: [
        { type: "stat", label: "Files", value: "3" },
        { type: "file", path: "apps/server/src/server.ts", line: 1 },
      ],
    });
    let written: ProjectWriteFileInput | undefined;

    const reference = Effect.runSync(
      writeCanvasArtifact({
        fileSystem: {
          writeFile: (input) => {
            written = input;
            return Effect.succeed({ relativePath: input.relativePath });
          },
        },
        request,
        threadId: "thread/one",
        fallbackCanvasId: "tool-call",
        now: 123,
      }),
    );

    expect(reference).toEqual({
      canvasId: "auth-canvas",
      title: "Auth analysis",
      relativePath: ".codework/canvases/thread-one/Auth-analysis.canvas.json",
    });
    expect(written).toBeDefined();
    expect(written?.relativePath).toBe(reference.relativePath);
    expect(JSON.parse(written?.contents ?? "")).toMatchObject({
      schemaVersion: 1,
      canvasId: "auth-canvas",
      createdAt: 123,
      updatedAt: 123,
    });
  });
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

  it("lists artifacts across thread directories, newest first", async () => {
    await writeFile(
      ".codework/canvases/thread-a/old.canvas.json",
      JSON.stringify({
        schemaVersion: 1,
        canvasId: "old",
        title: "Old",
        blocks: [{ type: "section", heading: "h", body: "b" }],
        relativePath: ".codework/canvases/thread-a/old.canvas.json",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await writeFile(
      ".codework/canvases/thread-b/new.canvas.json",
      JSON.stringify({
        schemaVersion: 1,
        canvasId: "new",
        title: "New",
        blocks: [{ type: "section", heading: "h", body: "b" }],
        relativePath: ".codework/canvases/thread-b/new.canvas.json",
        createdAt: 2,
        updatedAt: 2,
      }),
    );

    const canvases = await Effect.runPromise(listCanvasArtifacts({ workspacePaths, cwd: root }));

    expect(canvases.map((canvas) => canvas.canvasId)).toEqual(["new", "old"]);
  });

  it("skips invalid artifacts and unrelated files without failing", async () => {
    await writeFile(".codework/canvases/thread-a/broken.canvas.json", "{ not json");
    await writeFile(".codework/canvases/thread-a/notes.txt", "ignore me");
    await writeFile("src/not-a-canvas.json", JSON.stringify({ canvasId: "nope" }));

    const canvases = await Effect.runPromise(listCanvasArtifacts({ workspacePaths, cwd: root }));

    expect(canvases.map((canvas) => canvas.canvasId)).toEqual(["new", "old"]);
  });

  it("returns an empty listing when the canvases directory does not exist", async () => {
    const canvases = await Effect.runPromise(
      listCanvasArtifacts({
        workspacePaths,
        cwd: NodePath.join(root, "missing-workspace"),
      }),
    );

    expect(canvases).toEqual([]);
  });
});
