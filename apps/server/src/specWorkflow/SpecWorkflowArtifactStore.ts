import type {
  SpecWorkflowArtifact,
  SpecWorkflowArtifactListInput,
  SpecWorkflowArtifactName,
  SpecWorkflowArtifactReadInput,
  SpecWorkflowArtifactWriteInput,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const SpecWorkflowArtifactStoreErrorCode = Schema.Literals([
  "invalid-change-name",
  "artifact-not-found",
  "artifact-path-invalid",
  "artifact-read-failed",
  "artifact-write-failed",
]);
export type SpecWorkflowArtifactStoreErrorCode = typeof SpecWorkflowArtifactStoreErrorCode.Type;

export class SpecWorkflowArtifactStoreError extends Schema.TaggedErrorClass<SpecWorkflowArtifactStoreError>()(
  "SpecWorkflowArtifactStoreError",
  {
    code: SpecWorkflowArtifactStoreErrorCode,
    detail: Schema.String,
    workspaceRoot: Schema.String,
    changeName: Schema.String,
    artifact: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Spec Workflow 产物操作失败：${this.code}: ${this.detail}`;
  }
}

export interface SpecWorkflowArtifactStoreShape {
  readonly read: (
    input: SpecWorkflowArtifactReadInput,
  ) => Effect.Effect<SpecWorkflowArtifact, SpecWorkflowArtifactStoreError>;
  readonly write: (
    input: SpecWorkflowArtifactWriteInput,
  ) => Effect.Effect<SpecWorkflowArtifact, SpecWorkflowArtifactStoreError>;
  readonly list: (
    input: SpecWorkflowArtifactListInput,
  ) => Effect.Effect<ReadonlyArray<SpecWorkflowArtifactName>, SpecWorkflowArtifactStoreError>;
  readonly archive: (input: {
    readonly workspaceRoot: string;
    readonly changeName: string;
    /** 归档时间戳；目录名取其 UTC 日期，测试可以注入固定值。 */
    readonly archivedAtUnixMs: number;
  }) => Effect.Effect<
    /** archivedTo 为 null 表示没有可归档的 change 目录。 */
    { readonly archivedTo: string | null },
    SpecWorkflowArtifactStoreError
  >;
}

export class SpecWorkflowArtifactStore extends Context.Service<
  SpecWorkflowArtifactStore,
  SpecWorkflowArtifactStoreShape
>()("codework/specWorkflow/SpecWorkflowArtifactStore") {}

const artifactNames = [
  "fix.md",
  "research.md",
  "design.md",
  "proposal.md",
  "tasks.md",
  "verify.md",
  "retrospect.md",
  "knowledge.md",
] as const satisfies ReadonlyArray<SpecWorkflowArtifactName>;

const isArtifactName = (value: string): value is SpecWorkflowArtifactName =>
  artifactNames.includes(value as SpecWorkflowArtifactName);

/** knowledge.md 是跨 change 的工作区级知识索引，不落在 changes 目录下。 */
const isWorkspaceLevelArtifact = (artifact: SpecWorkflowArtifactName): boolean =>
  artifact === "knowledge.md";

const workspaceRelativePathFor = (changeName: string, artifact: SpecWorkflowArtifactName): string =>
  isWorkspaceLevelArtifact(artifact)
    ? `spec/knowledge.md`
    : `spec/changes/${changeName}/${artifact}`;

const isSafeChangeName = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 100;

const isNotFound = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null || !("reason" in cause)) return false;
  const reason = (cause as { readonly reason?: unknown }).reason;
  return typeof reason === "object" && reason !== null && "_tag" in reason
    ? (reason as { readonly _tag?: unknown })._tag === "NotFound"
    : false;
};

export const SpecWorkflowArtifactStoreLive = Layer.effect(
  SpecWorkflowArtifactStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const validateChangeName = (changeName: string, workspaceRoot: string) =>
      isSafeChangeName(changeName)
        ? Effect.void
        : Effect.fail(
            new SpecWorkflowArtifactStoreError({
              code: "invalid-change-name",
              detail: "changeName 必须是小写字母、数字和连字符组成的安全名称。",
              workspaceRoot,
              changeName,
            }),
          );
    const resolveArtifact = (
      input: SpecWorkflowArtifactReadInput | SpecWorkflowArtifactWriteInput,
    ) =>
      Effect.gen(function* () {
        if (!isWorkspaceLevelArtifact(input.artifact))
          yield* validateChangeName(input.changeName, input.workspaceRoot);
        const toPathError = (cause: unknown) =>
          new SpecWorkflowArtifactStoreError({
            code: "artifact-path-invalid",
            detail: cause instanceof Error ? cause.message : "Spec Workflow 产物路径无效。",
            workspaceRoot: input.workspaceRoot,
            changeName: input.changeName,
            artifact: input.artifact,
            cause,
          });
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(input.workspaceRoot)
          .pipe(Effect.mapError(toPathError));
        return yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot,
            relativePath: workspaceRelativePathFor(input.changeName, input.artifact),
          })
          .pipe(Effect.mapError(toPathError));
      });
    const resolve = (
      input: SpecWorkflowArtifactReadInput | SpecWorkflowArtifactListInput,
      relativePath: string,
    ) =>
      Effect.gen(function* () {
        yield* validateChangeName(input.changeName, input.workspaceRoot);
        const toPathError = (cause: unknown) =>
          new SpecWorkflowArtifactStoreError({
            code: "artifact-path-invalid",
            detail: cause instanceof Error ? cause.message : "Spec Workflow 产物路径无效。",
            workspaceRoot: input.workspaceRoot,
            changeName: input.changeName,
            ...("artifact" in input ? { artifact: input.artifact } : {}),
            cause,
          });
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(input.workspaceRoot)
          .pipe(Effect.mapError(toPathError));
        return yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
          .pipe(Effect.mapError(toPathError));
      });

    const read: SpecWorkflowArtifactStoreShape["read"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveArtifact(input);
        const contents = yield* fileSystem.readFileString(resolved.absolutePath).pipe(
          Effect.mapError(
            (cause) =>
              new SpecWorkflowArtifactStoreError({
                code: isNotFound(cause) ? "artifact-not-found" : "artifact-read-failed",
                detail: isNotFound(cause)
                  ? "指定的 Spec Workflow 产物不存在。"
                  : "读取 Spec Workflow 产物失败。",
                workspaceRoot: input.workspaceRoot,
                changeName: input.changeName,
                artifact: input.artifact,
                cause,
              }),
          ),
        );
        return { changeName: input.changeName, artifact: input.artifact, contents };
      });

    const write: SpecWorkflowArtifactStoreShape["write"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveArtifact(input);
        yield* writeFileStringAtomically({
          filePath: resolved.absolutePath,
          contents: input.contents,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new SpecWorkflowArtifactStoreError({
                code: "artifact-write-failed",
                detail: "写入 Spec Workflow 产物失败。",
                workspaceRoot: input.workspaceRoot,
                changeName: input.changeName,
                artifact: input.artifact,
                cause,
              }),
          ),
        );
        return { changeName: input.changeName, artifact: input.artifact, contents: input.contents };
      });

    const list: SpecWorkflowArtifactStoreShape["list"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(input, `spec/changes/${input.changeName}`);
        const entries = yield* fileSystem.readDirectory(resolved.absolutePath).pipe(
          Effect.mapError(
            (cause) =>
              new SpecWorkflowArtifactStoreError({
                code: isNotFound(cause) ? "artifact-not-found" : "artifact-read-failed",
                detail: isNotFound(cause)
                  ? "指定的 Spec Workflow change 不存在。"
                  : "读取 Spec Workflow change 目录失败。",
                workspaceRoot: input.workspaceRoot,
                changeName: input.changeName,
                cause,
              }),
          ),
        );
        return entries.filter(isArtifactName);
      });

    const archive: SpecWorkflowArtifactStoreShape["archive"] = (input) =>
      Effect.gen(function* () {
        const toStoreError = (
          code: SpecWorkflowArtifactStoreErrorCode,
          detail: string,
          cause?: unknown,
        ) =>
          new SpecWorkflowArtifactStoreError({
            code,
            detail,
            workspaceRoot: input.workspaceRoot,
            changeName: input.changeName,
            ...(cause === undefined ? {} : { cause }),
          });
        if (!isSafeChangeName(input.changeName)) {
          return yield* toStoreError(
            "invalid-change-name",
            "changeName 必须是小写字母、数字和连字符组成的安全名称。",
          );
        }
        const toPathError = (cause: unknown) =>
          toStoreError(
            "artifact-path-invalid",
            cause instanceof Error ? cause.message : "Spec Workflow 产物路径无效。",
            cause,
          );
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(input.workspaceRoot)
          .pipe(Effect.mapError(toPathError));
        const source = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot,
            relativePath: `spec/changes/${input.changeName}`,
          })
          .pipe(Effect.mapError(toPathError));
        const sourceExists = yield* fileSystem
          .exists(source.absolutePath)
          .pipe(Effect.mapError(toPathError));
        if (!sourceExists) return { archivedTo: null };

        const archiveRoot = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: "spec/archive" })
          .pipe(Effect.mapError(toPathError));
        yield* fileSystem
          .makeDirectory(archiveRoot.absolutePath, { recursive: true })
          .pipe(Effect.mapError(toPathError));
        const dateStamp = DateTime.formatIso(DateTime.makeUnsafe(input.archivedAtUnixMs)).slice(
          0,
          10,
        );
        const pickTarget = (
          attempt: number,
        ): Effect.Effect<string, SpecWorkflowArtifactStoreError> =>
          Effect.gen(function* () {
            const suffix = attempt === 1 ? "" : `-${attempt}`;
            const candidate = `${archiveRoot.absolutePath}/${dateStamp}-${input.changeName}${suffix}`;
            const taken = yield* fileSystem.exists(candidate).pipe(Effect.mapError(toPathError));
            return taken ? yield* pickTarget(attempt + 1) : candidate;
          });
        const targetPath = yield* pickTarget(1);
        yield* fileSystem
          .rename(source.absolutePath, targetPath)
          .pipe(
            Effect.mapError((cause) =>
              toStoreError(
                "artifact-write-failed",
                "移动 Spec Workflow change 到归档目录失败。",
                cause,
              ),
            ),
          );
        return { archivedTo: targetPath };
      });

    return { read, write, list, archive } satisfies SpecWorkflowArtifactStoreShape;
  }),
);
