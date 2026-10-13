import { ProviderDriverKind } from "@codework/contracts";
import { compareSemverVersions } from "@codework/shared/semver";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { cliProviderCatalogIdentity } from "./CliProviderCatalog.ts";
import { makeProviderCatalogCache } from "./ProviderCatalogCache.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "./opencodeRuntime.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";
const OPENCODE_CATALOG_TIMEOUT_MS = 15_000;

export type OpenCodeCatalogData =
  | {
      readonly status: "ready";
      readonly version: string | null;
      readonly inventory: OpenCodeInventory;
    }
  | { readonly status: "unsupported"; readonly version: string };

export class OpenCodeCatalogError extends Data.TaggedError("OpenCodeCatalogError")<{
  readonly cause: unknown;
  readonly detail: string;
  readonly version: string | null;
}> {}

export interface OpenCodeCatalogInput {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface OpenCodeCatalog {
  readonly fetchCatalog: (
    input: OpenCodeCatalogInput,
  ) => Effect.Effect<OpenCodeCatalogData, OpenCodeCatalogError, OpenCodeRuntime>;
}

/** inventory 包含当前 connected 状态，仅共享进行中的完整刷新，不保存成功认证。 */
export const makeOpenCodeCatalog = Effect.fn("makeOpenCodeCatalog")(function* () {
  const cache = yield* makeProviderCatalogCache<
    Result.Result<OpenCodeCatalogData, OpenCodeCatalogError>
  >({ ttlMs: 0, capacity: 0, shouldCache: () => false });

  const fetchCatalog: OpenCodeCatalog["fetchCatalog"] = Effect.fn("OpenCodeCatalog.fetchCatalog")(
    function* (input: OpenCodeCatalogInput) {
      const context = yield* Effect.context<OpenCodeRuntime>();
      const runtime = yield* OpenCodeRuntime;
      const probeInput = {
        ...input,
        serverUrl: input.serverUrl.trim(),
        environment: { ...input.environment },
      };
      const { serverUrl, environment } = probeInput;
      const key = cliProviderCatalogIdentity({
        driver: ProviderDriverKind.make("opencode"),
        operation: "inventory",
        config: serverUrl
          ? { serverUrl, serverPassword: probeInput.serverPassword }
          : { binaryPath: probeInput.binaryPath },
        cwd: probeInput.cwd,
        ...(serverUrl ? {} : { environment }),
      });
      // 版本、重试和目录共用一个预算；错误仍携带已经验证的版本。
      let version: string | null = null;
      const load = Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const signal = controller.signal;
        if (!serverUrl) {
          const result = yield* runtime.runOpenCodeCommand({
            binaryPath: probeInput.binaryPath,
            args: ["--version"],
            cwd: probeInput.cwd,
            environment,
            extendEnv: false,
            signal,
          });
          if (result.code !== 0) {
            return yield* new OpenCodeRuntimeError({
              operation: "version",
              detail:
                result.stderr.trim() || `OpenCode version check exited with code ${result.code}.`,
            });
          }
          version = parseGenericCliVersion(result.stdout) ?? null;
          if (!version) {
            return yield* new OpenCodeRuntimeError({
              operation: "version",
              detail: `Unable to determine OpenCode version from \`opencode --version\` output. Code Work requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
            });
          }
          if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
            return { status: "unsupported", version } satisfies OpenCodeCatalogData;
          }
        }

        const inventory = yield* serverUrl
          ? runtime.loadOpenCodeInventory(
              runtime.createOpenCodeSdkClient({
                baseUrl: serverUrl,
                directory: probeInput.cwd,
                ...(probeInput.serverPassword ? { serverPassword: probeInput.serverPassword } : {}),
              }),
              signal,
            )
          : runtime.loadInventoryFromCli({
              binaryPath: probeInput.binaryPath,
              cwd: probeInput.cwd,
              environment,
              extendEnv: false,
              signal,
            });
        return { status: "ready", version, inventory } satisfies OpenCodeCatalogData;
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new OpenCodeCatalogError({ cause, detail: openCodeRuntimeErrorDetail(cause), version }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          const failure = Cause.squash(cause);
          return Effect.fail(
            failure instanceof OpenCodeCatalogError
              ? failure
              : new OpenCodeCatalogError({
                  cause: failure,
                  detail: openCodeRuntimeErrorDetail(failure),
                  version,
                }),
          );
        }),
        Effect.timeoutOrElse({
          duration: OPENCODE_CATALOG_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new OpenCodeCatalogError({
                cause: new Error("OpenCode catalog refresh timed out."),
                detail: "OpenCode catalog refresh timed out after 15 seconds.",
                version,
              }),
            ),
        }),
        Effect.provide(context),
        Effect.result,
      );
      const result = yield* cache.fetchCatalog({ key, load });
      return Result.isSuccess(result.value) ? result.value.success : yield* result.value.failure;
    },
  );

  return { fetchCatalog } satisfies OpenCodeCatalog;
});
