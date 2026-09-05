import type { ServerSettingsPatch } from "@codework/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@codework/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const textEncoder = new TextEncoder();
const LOCK_RETRY_DELAY = Duration.millis(25);
const LOCK_WAIT_TIMEOUT_MS = 30_000;

const ServerSettingsOriginLockOwner = Schema.Struct({
  token: Schema.String,
  pid: Schema.Int,
  createdAtUnixMs: Schema.Int,
});
type ServerSettingsOriginLockOwner = typeof ServerSettingsOriginLockOwner.Type;

const encodeLockOwner = Schema.encodeEffect(fromJsonStringPretty(ServerSettingsOriginLockOwner));
const decodeLockOwnerExit = Schema.decodeUnknownExit(
  fromLenientJson(ServerSettingsOriginLockOwner),
);

export interface ServerSettingsOriginSnapshot {
  readonly raw: string | null;
  readonly token: string;
}

export interface ServerSettingsOriginCommitHookInput {
  readonly settingsPath: string;
  readonly patch: ServerSettingsPatch;
  readonly token: string;
}

export type ServerSettingsOriginCommitHookFunction = (
  input: ServerSettingsOriginCommitHookInput,
) => Effect.Effect<void>;

export class ServerSettingsOriginCommitHook extends Context.Reference<ServerSettingsOriginCommitHookFunction>(
  "codework/serverSettings/ServerSettingsOriginCommitHook",
  {
    defaultValue: () => () => Effect.void,
  },
) {}

export class ServerSettingsOriginError extends Schema.TaggedErrorClass<ServerSettingsOriginError>()(
  "ServerSettingsOriginError",
  {
    settingsPath: Schema.String,
    operation: Schema.Literals([
      "read-origin",
      "hash-origin",
      "prepare-lock",
      "acquire-lock",
      "inspect-lock",
      "release-lock",
      "write-origin",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class ServerSettingsOriginConflict extends Data.TaggedError("ServerSettingsOriginConflict")<{
  readonly settingsPath: string;
  readonly expectedToken: string;
  readonly actualToken: string;
}> {}

export class ServerSettingsOriginCompensationError extends Data.TaggedError(
  "ServerSettingsOriginCompensationError",
)<{
  readonly settingsPath: string;
  readonly primaryFailure: ServerSettingsOriginError | ServerSettingsOriginConflict;
  readonly compensationFailure: unknown;
}> {}

interface ServerSettingsOriginLockLease {
  readonly settingsPath: string;
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly owner: ServerSettingsOriginLockOwner;
}

export interface ServerSettingsOriginCommitPlan<A, E, R> {
  readonly contents: string;
  readonly value: A;
  readonly compensate: Effect.Effect<void, E, R>;
}

export type ServerSettingsOriginCommitResult<A> =
  | {
      readonly _tag: "Committed";
      readonly value: A;
      readonly snapshot: ServerSettingsOriginSnapshot;
    }
  | {
      readonly _tag: "Conflict";
      readonly snapshot: ServerSettingsOriginSnapshot;
    };

const isFileSystemReason = (
  error: PlatformError.PlatformError,
  reason: "AlreadyExists" | "NotFound",
): boolean => error.reason._tag === reason;

const originError = (
  settingsPath: string,
  operation: ServerSettingsOriginError["operation"],
  cause: unknown,
) => new ServerSettingsOriginError({ settingsPath, operation, cause });

const makeOriginToken = Effect.fn("ServerSettingsOriginCas.makeOriginToken")(function* (
  settingsPath: string,
  raw: string | null,
) {
  const crypto = yield* Crypto.Crypto;
  const bytes = textEncoder.encode(raw === null ? "missing\0" : `present\0${raw}`);
  const digest = yield* crypto
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError((cause) => originError(settingsPath, "hash-origin", cause)));
  return Encoding.encodeHex(digest);
});

export const readServerSettingsOriginSnapshot = Effect.fn("ServerSettingsOriginCas.readSnapshot")(
  function* (settingsPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.map((value): string | null => value),
      Effect.catch((cause) =>
        isFileSystemReason(cause, "NotFound")
          ? Effect.succeed(null)
          : Effect.fail(originError(settingsPath, "read-origin", cause)),
      ),
    );
    return {
      raw,
      token: yield* makeOriginToken(settingsPath, raw),
    } satisfies ServerSettingsOriginSnapshot;
  },
);

const readLockOwner = Effect.fn("ServerSettingsOriginCas.readLockOwner")(function* (
  lease: Pick<ServerSettingsOriginLockLease, "settingsPath" | "ownerPath">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(lease.ownerPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      isFileSystemReason(cause, "NotFound")
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(originError(lease.settingsPath, "inspect-lock", cause)),
    ),
  );
  if (Option.isNone(raw)) return Option.none<ServerSettingsOriginLockOwner>();
  const decoded = decodeLockOwnerExit(raw.value);
  return decoded._tag === "Success"
    ? Option.some(decoded.value)
    : Option.none<ServerSettingsOriginLockOwner>();
});

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause) {
      return cause.code !== "ESRCH";
    }
    return true;
  }
};

const publishPreparedLock = Effect.fn("ServerSettingsOriginCas.publishPreparedLock")(
  function* (input: {
    readonly settingsPath: string;
    readonly candidatePath: string;
    readonly lockPath: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.rename(input.candidatePath, input.lockPath).pipe(
      Effect.as(true),
      Effect.catch((cause) => {
        // 竞争者可能在 rename 失败后立即释放锁，不能靠随后 exists 的结果判断是否发生竞争。
        const systemCause = cause.cause;
        if (
          isFileSystemReason(cause, "AlreadyExists") ||
          (systemCause !== null &&
            typeof systemCause === "object" &&
            "code" in systemCause &&
            systemCause.code === "ENOTEMPTY")
        ) {
          return Effect.succeed(false);
        }
        return fileSystem.exists(input.lockPath).pipe(
          Effect.mapError((inspectCause) =>
            originError(input.settingsPath, "inspect-lock", inspectCause),
          ),
          Effect.flatMap((exists) =>
            exists
              ? Effect.succeed(false)
              : Effect.fail(originError(input.settingsPath, "acquire-lock", cause)),
          ),
        );
      }),
    );
  },
);

const acquireOriginLock = Effect.fn("ServerSettingsOriginCas.acquireLock")(function* (
  settingsPath: string,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedSettingsPath = path.resolve(settingsPath);
  const lockPath = `${resolvedSettingsPath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");

  yield* fileSystem
    .makeDirectory(path.dirname(resolvedSettingsPath), { recursive: true })
    .pipe(Effect.mapError((cause) => originError(settingsPath, "prepare-lock", cause)));

  const owner = {
    token: yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => originError(settingsPath, "acquire-lock", cause)),
    ),
    pid: process.pid,
    createdAtUnixMs: yield* Clock.currentTimeMillis,
  } satisfies ServerSettingsOriginLockOwner;
  const ownerJson = yield* encodeLockOwner(owner).pipe(
    Effect.mapError((cause) => originError(settingsPath, "acquire-lock", cause)),
  );
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  const candidateOwnerPath = path.join(candidatePath, "owner.json");
  yield* fileSystem
    .makeDirectory(candidatePath, { mode: 0o700 })
    .pipe(Effect.mapError((cause) => originError(settingsPath, "prepare-lock", cause)));
  yield* fileSystem
    .writeFileString(candidateOwnerPath, `${ownerJson}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(
      Effect.mapError((cause) => originError(settingsPath, "prepare-lock", cause)),
      Effect.onError(() =>
        fileSystem.remove(candidatePath, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );

  const startedAtUnixMs = yield* Clock.currentTimeMillis;
  return yield* Effect.gen(function* () {
    while (true) {
      if (yield* publishPreparedLock({ settingsPath, candidatePath, lockPath })) {
        return { settingsPath, lockPath, ownerPath, owner } satisfies ServerSettingsOriginLockLease;
      }

      const contendedOwner = yield* readLockOwner({ settingsPath, ownerPath });
      if (
        Option.isSome(contendedOwner) &&
        contendedOwner.value.pid !== process.pid &&
        !isProcessAlive(contendedOwner.value.pid)
      ) {
        return yield* new ServerSettingsOriginError({
          settingsPath,
          operation: "acquire-lock",
          cause: new Error(
            `检测到已退出进程 ${contendedOwner.value.pid} 遗留的 ServerSettings 写锁；为避免 ABA 误删新锁，拒绝自动回收 ${lockPath}。`,
          ),
        });
      }
      if ((yield* Clock.currentTimeMillis) - startedAtUnixMs >= LOCK_WAIT_TIMEOUT_MS) {
        return yield* new ServerSettingsOriginError({
          settingsPath,
          operation: "acquire-lock",
          cause: new Error("等待另一个 ServerSettings 写入者释放磁盘锁超时。"),
        });
      }
      yield* Effect.sleep(LOCK_RETRY_DELAY);
    }
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(candidatePath, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  );
});

const releaseOriginLock = Effect.fn("ServerSettingsOriginCas.releaseLock")(function* (
  lease: ServerSettingsOriginLockLease,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const owner = yield* readLockOwner(lease);
  if (Option.isNone(owner) || owner.value.token !== lease.owner.token) {
    return yield* new ServerSettingsOriginError({
      settingsPath: lease.settingsPath,
      operation: "release-lock",
      cause: new Error("ServerSettings 写锁 owner 已变化，拒绝删除不属于当前写入者的锁。"),
    });
  }

  const releasePath = `${lease.lockPath}.release-${lease.owner.token}`;
  yield* fileSystem
    .rename(lease.lockPath, releasePath)
    .pipe(Effect.mapError((cause) => originError(lease.settingsPath, "release-lock", cause)));
  yield* fileSystem.remove(releasePath, { recursive: true, force: true }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("清理已释放的 ServerSettings 写锁目录失败。", {
        settingsPath: lease.settingsPath,
        releasePath,
        cause,
      }),
    ),
  );
});

export const withServerSettingsOriginLock = <A, E, R>(
  settingsPath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | ServerSettingsOriginError,
  R | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> => Effect.acquireUseRelease(acquireOriginLock(settingsPath), () => effect, releaseOriginLock);

export const commitServerSettingsOriginCas = <A, E, R>(input: {
  readonly settingsPath: string;
  readonly expectedToken: string;
  readonly prepare: Effect.Effect<ServerSettingsOriginCommitPlan<A, E, R>, E, R>;
}): Effect.Effect<
  ServerSettingsOriginCommitResult<A>,
  E | ServerSettingsOriginError | ServerSettingsOriginCompensationError,
  R | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  withServerSettingsOriginLock(
    input.settingsPath,
    Effect.gen(function* () {
      const lockedSnapshot = yield* readServerSettingsOriginSnapshot(input.settingsPath);
      if (lockedSnapshot.token !== input.expectedToken) {
        return { _tag: "Conflict", snapshot: lockedSnapshot } as const;
      }

      const plan = yield* input.prepare;
      const beforeReplace = yield* readServerSettingsOriginSnapshot(input.settingsPath);
      if (beforeReplace.token !== lockedSnapshot.token) {
        const primaryFailure = new ServerSettingsOriginConflict({
          settingsPath: input.settingsPath,
          expectedToken: lockedSnapshot.token,
          actualToken: beforeReplace.token,
        });
        return yield* Effect.uninterruptible(plan.compensate).pipe(
          Effect.matchCauseEffect({
            onFailure: (compensationCause) =>
              Effect.fail(
                new ServerSettingsOriginCompensationError({
                  settingsPath: input.settingsPath,
                  primaryFailure,
                  compensationFailure: Cause.squash(compensationCause),
                }),
              ),
            onSuccess: () => Effect.succeed({ _tag: "Conflict", snapshot: beforeReplace } as const),
          }),
        );
      }

      yield* writeFileStringAtomically({
        filePath: input.settingsPath,
        contents: plan.contents,
      }).pipe(
        Effect.mapError((cause) => originError(input.settingsPath, "write-origin", cause)),
        Effect.catch((primaryFailure) =>
          Effect.uninterruptible(plan.compensate).pipe(
            Effect.matchCauseEffect({
              onFailure: (compensationCause) =>
                Effect.fail(
                  new ServerSettingsOriginCompensationError({
                    settingsPath: input.settingsPath,
                    primaryFailure,
                    compensationFailure: Cause.squash(compensationCause),
                  }),
                ),
              onSuccess: () => Effect.fail(primaryFailure),
            }),
          ),
        ),
      );
      return {
        _tag: "Committed",
        value: plan.value,
        snapshot: {
          raw: plan.contents,
          token: yield* makeOriginToken(input.settingsPath, plan.contents),
        },
      } as const;
    }),
  );
