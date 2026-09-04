import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { writeCanvasArtifact } from "../../../canvas/CanvasArtifact.ts";
import { CanvasToolkit } from "./tools.ts";

const handlers = {
  canvas_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("canvas");
      const fileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      return yield* writeCanvasArtifact({
        fileSystem,
        request: input,
        threadId: String(scope.threadId),
        fallbackCanvasId: "mcp-canvas",
      });
    }),
} satisfies Parameters<typeof CanvasToolkit.toLayer>[0];

export const CanvasToolkitHandlersLive = CanvasToolkit.toLayer(handlers);
