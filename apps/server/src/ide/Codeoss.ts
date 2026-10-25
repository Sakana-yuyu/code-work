import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  IdeError,
  type AuthSessionId,
  type IdeOpenInput,
  type IdeOpenResult,
} from "@codework/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import { ServerConfig } from "../config.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { CodeossRuntime } from "./codeossRuntime.ts";

export class Codeoss extends Context.Service<
  Codeoss,
  {
    runtime: CodeossRuntime;
    open: (
      sessionId: AuthSessionId,
      input: typeof IdeOpenInput.Type,
    ) => Effect.Effect<IdeOpenResult, IdeError>;
  }
>()("codework/ide/Codeoss") {}

export const layer = Layer.effect(
  Codeoss,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const sessions = yield* SessionStore;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new CodeossRuntime(path.join(config.baseDir, "ide"), platform, arch)),
      (service) => Effect.promise(() => service.dispose()),
    );
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved"
          ? Effect.promise(() => runtime.close(change.sessionId))
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    return {
      runtime,
      open: (sessionId, input) =>
        Effect.gen(function* () {
          const ticket = yield* sessions.issueWebSocketToken(sessionId, {
            ttl: Duration.hours(24),
          });
          return yield* Effect.tryPromise(() =>
            runtime.open(sessionId, ticket.token, input.cwd, input.retry),
          );
        }).pipe(
          Effect.mapError(
            () => new IdeError({ message: "无法打开 IDE，请检查项目目录和环境连接。" }),
          ),
        ),
    };
  }),
);
