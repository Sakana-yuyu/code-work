import * as Cause from "effect/Cause";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const INTENTS_DIRECTORY = ".thread-history-cleanup";
const QUARANTINE_DIRECTORY = "quarantine";
export const MIN_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 30_000;

export const ThreadHistoryCleanupIntent = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - 1),
  ),
  nextRetryDelayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_RETRY_DELAY_MS)).check(
    Schema.isLessThanOrEqualTo(MAX_RETRY_DELAY_MS),
  ),
});
export type ThreadHistoryCleanupIntent = typeof ThreadHistoryCleanupIntent.Type;

export class ThreadHistoryCleanupIntentStoreError extends Schema.TaggedErrorClass<ThreadHistoryCleanupIntentStoreError>()(
  "ThreadHistoryCleanupIntentStoreError",
  {
    operation: Schema.Literals(["read", "write", "remove"]),
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeThreadHistoryCleanupIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadHistoryCleanupIntent),
);
const encodeThreadHistoryCleanupIntent = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ThreadHistoryCleanupIntent),
);

const safeThreadId = (threadId: string) => `terminal_${Encoding.encodeBase64Url(threadId)}`;

export interface ThreadHistoryCleanupIntentStore {
  readonly intentsDir: string;
  readonly quarantineDir: string;
  readonly intentPath: (threadId: string) => string;
  readonly write: (
    intent: ThreadHistoryCleanupIntent,
  ) => Effect.Effect<void, ThreadHistoryCleanupIntentStoreError>;
  readonly remove: (threadId: string) => Effect.Effect<void, ThreadHistoryCleanupIntentStoreError>;
  readonly readAll: () => Effect.Effect<
    ReadonlyArray<ThreadHistoryCleanupIntent>,
    ThreadHistoryCleanupIntentStoreError
  >;
}

export const make = Effect.fn("terminal.ThreadHistoryCleanupIntentStore.make")(function* (input: {
  readonly logsDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const intentsDir = path.join(input.logsDir, INTENTS_DIRECTORY);
  const quarantineDir = path.join(intentsDir, QUARANTINE_DIRECTORY);
  const intentPath = (threadId: string) => path.join(intentsDir, `${safeThreadId(threadId)}.json`);
  const mapError = (operation: "read" | "write" | "remove", threadId: string, cause: unknown) =>
    new ThreadHistoryCleanupIntentStoreError({ operation, threadId, cause });

  const write: ThreadHistoryCleanupIntentStore["write"] = Effect.fn(
    "terminal.ThreadHistoryCleanupIntentStore.write",
  )(function* (intent) {
    const contents = yield* encodeThreadHistoryCleanupIntent(intent).pipe(
      Effect.mapError((cause) => mapError("write", intent.threadId, cause)),
    );
    yield* writeFileStringAtomically({ filePath: intentPath(intent.threadId), contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => mapError("write", intent.threadId, cause)),
    );
  });

  const remove: ThreadHistoryCleanupIntentStore["remove"] = Effect.fn(
    "terminal.ThreadHistoryCleanupIntentStore.remove",
  )(function* (threadId) {
    yield* fileSystem.remove(intentPath(threadId), { force: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(mapError("remove", threadId, cause)),
      }),
    );
  });

  const quarantineInvalidIntent = Effect.fn(
    "terminal.ThreadHistoryCleanupIntentStore.quarantineInvalidIntent",
  )(function* (fileName: string, cause: Cause.Cause<unknown>) {
    const sourcePath = path.join(intentsDir, fileName);
    const quarantined = yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(quarantineDir, { recursive: true });
      const directory = yield* fileSystem.makeTempDirectory({
        directory: quarantineDir,
        prefix: "invalid-intent-",
      });
      yield* fileSystem.rename(sourcePath, path.join(directory, fileName));
    }).pipe(Effect.exit);
    if (Exit.isSuccess(quarantined)) {
      yield* Effect.logWarning("quarantined invalid thread terminal history cleanup intent", {
        fileName,
        cause: Cause.pretty(cause),
      });
      return;
    }
    yield* Effect.logWarning(
      "failed to quarantine invalid thread terminal history cleanup intent",
      {
        fileName,
        cause: Cause.pretty(cause),
        quarantineCause: Cause.pretty(quarantined.cause),
      },
    );
  });

  const readAll: ThreadHistoryCleanupIntentStore["readAll"] = Effect.fn(
    "terminal.ThreadHistoryCleanupIntentStore.readAll",
  )(function* () {
    const entries = yield* fileSystem.readDirectory(intentsDir, { recursive: false }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed([] as Array<string>)
            : Effect.fail(mapError("read", "*", cause)),
      }),
    );
    const intents: Array<ThreadHistoryCleanupIntent> = [];
    for (const fileName of entries.filter((entry) => entry.endsWith(".json"))) {
      const contents = yield* fileSystem.readFileString(path.join(intentsDir, fileName)).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none())
              : Effect.fail(mapError("read", "*", cause)),
        }),
      );
      if (Option.isNone(contents)) continue;
      const decoded = yield* decodeThreadHistoryCleanupIntent(contents.value).pipe(Effect.exit);
      if (Exit.isSuccess(decoded)) {
        if (fileName === `${safeThreadId(decoded.value.threadId)}.json`) {
          intents.push(decoded.value);
          continue;
        }
        yield* quarantineInvalidIntent(
          fileName,
          Cause.die(
            new Error("thread terminal history cleanup intent file name does not match threadId"),
          ),
        );
        continue;
      }
      yield* quarantineInvalidIntent(fileName, decoded.cause);
    }
    return intents;
  });

  return { intentsDir, quarantineDir, intentPath, write, remove, readAll };
});
