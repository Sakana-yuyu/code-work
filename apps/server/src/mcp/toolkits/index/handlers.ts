import { CodeIndexUnavailableError } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CodeIndexRoot, CodeIndexRootMap } from "../../../codeIndex/CodeIndexService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IndexToolkit } from "./tools.ts";

const DEFAULT_SEARCH_LIMIT = 25;

/**
 * The index is partitioned by the thread's effective working root, so worktree
 * threads get their own slice of the index while sharing the project store.
 */
const resolveThreadIndexRoot = Effect.fn("index.resolveThreadIndexRoot")(function* () {
  const invocation = yield* McpInvocationContext.requireMcpCapability("index").pipe(
    Effect.mapError(
      (cause): CodeIndexUnavailableError =>
        new CodeIndexUnavailableError({
          reason: `Index capability not granted for this session (${cause.capability}).`,
        }),
    ),
  );
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const shell = yield* projection
    .getThreadShellById(invocation.threadId)
    .pipe(
      Effect.mapError(
        (): CodeIndexUnavailableError =>
          new CodeIndexUnavailableError({ reason: "Project lookup failed." }),
      ),
    );
  if (Option.isNone(shell)) {
    return yield* new CodeIndexUnavailableError({
      reason: "Thread has no active project to index.",
    });
  }
  // worktree 线程索引自己的工作树；普通线程回落到项目根目录。
  if (shell.value.worktreePath !== null) {
    return { root: shell.value.worktreePath };
  }
  const project = yield* projection
    .getProjectShellById(shell.value.projectId)
    .pipe(
      Effect.mapError(
        (): CodeIndexUnavailableError =>
          new CodeIndexUnavailableError({ reason: "Project lookup failed." }),
      ),
    );
  if (Option.isNone(project)) {
    return yield* new CodeIndexUnavailableError({
      reason: "Thread has no active project to index.",
    });
  }
  return { root: project.value.workspaceRoot };
});

const handlers = {
  index_search: (input) =>
    Effect.gen(function* () {
      const { root } = yield* resolveThreadIndexRoot();
      const indexMap = yield* CodeIndexRootMap;
      const matches = (yield* Effect.gen(function* () {
        const index = yield* CodeIndexRoot;
        return yield* index.search({
          query: input.query,
          kind: input.kind,
          limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
        });
      }).pipe(Effect.provide(indexMap.get(root)))).map((match) => ({
        path: match.path,
        name: match.name,
        kind: match.kind,
        line: match.line,
        ...(match.parent === undefined ? {} : { parent: match.parent }),
      }));
      return { matches };
    }),
  index_file_symbols: (input) =>
    Effect.gen(function* () {
      const { root } = yield* resolveThreadIndexRoot();
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: root,
        relativePath: input.path,
      });
      const indexMap = yield* CodeIndexRootMap;
      const symbols = (yield* Effect.gen(function* () {
        const index = yield* CodeIndexRoot;
        return yield* index.fileSymbols(input.path);
      }).pipe(Effect.provide(indexMap.get(root)))).map((symbol) => ({
        path: input.path,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        ...(symbol.parent === undefined ? {} : { parent: symbol.parent }),
      }));
      return { symbols };
    }),
} satisfies Parameters<typeof IndexToolkit.toLayer>[0];

export const IndexToolkitHandlersLive = IndexToolkit.toLayer(handlers);
