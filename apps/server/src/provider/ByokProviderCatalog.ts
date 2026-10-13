import {
  ProviderDriverKind,
  type ByokSettings,
  type ServerProviderSkill,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverByokSkills } from "../skillDiscovery.ts";
import { cliProviderCatalogIdentity } from "./CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "./NativeProviderCatalog.ts";
import {
  ByokCatalog,
  byokCatalogIdentity,
  byokCatalogTargetFromAdapter,
} from "./byok/ByokCatalog.ts";
import { BYOK_HTTP_TIMEOUT_MS } from "./byok/byokHttp.ts";
import {
  buildInitialByokProviderSnapshot,
  checkByokProviderStatus,
} from "./Layers/ByokProvider.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

/** 模型与本地技能共用刷新预算；实际 HTTP 目录仍独立共享在途加载和信号。 */
export const fetchByokProviderCatalog = Effect.fn("fetchByokProviderCatalog")(function* (request: {
  readonly settings: ByokSettings;
  readonly cwd: string;
  readonly nativeCatalog?: NativeProviderCatalog;
}): Effect.fn.Return<ServerProviderDraft, never, ByokCatalog | FileSystem.FileSystem | Path.Path> {
  const settings = {
    ...request.settings,
    adapters: request.settings.adapters.map((adapter) => ({
      ...adapter,
      ...(adapter.modelCatalogURLs === undefined
        ? {}
        : { modelCatalogURLs: [...adapter.modelCatalogURLs] }),
    })),
  };
  const cwd = request.cwd;
  const native = request.nativeCatalog ?? (yield* makeNativeProviderCatalog());
  let draft = yield* buildInitialByokProviderSnapshot(settings);
  let skills: ReadonlyArray<ServerProviderSkill> = [];
  const snapshot = yield* native.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("byok"),
      operation: "byok/provider-refresh",
      config: {
        enabled: settings.enabled,
        adapters: settings.adapters.map((adapter) => ({
          id: adapter.id,
          displayName: adapter.displayName,
          groupName: adapter.groupName,
          modelId: adapter.modelId,
          target: byokCatalogIdentity(byokCatalogTargetFromAdapter(adapter)),
        })),
      },
      cwd,
    }),
    timeoutMs: BYOK_HTTP_TIMEOUT_MS,
    onTimeout: () => ({
      ...draft,
      skills: [...skills],
      message:
        `${draft.message ?? ""} 模型或技能目录刷新超过十五秒；已完成的结果保留，可再次刷新。`.trim(),
    }),
    load: () =>
      Effect.gen(function* () {
        // 两个分支独立保留完成值，挂起的文件读取不能拖延模型发布或重置预算。
        yield* Effect.all(
          [
            checkByokProviderStatus(settings, {
              onModels: (models) => {
                draft = { ...draft, models };
              },
            }).pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => {
                  draft = snapshot;
                }),
              ),
            ),
            discoverByokSkills(cwd).pipe(
              Effect.tap((discovered) =>
                Effect.sync(() => {
                  skills = discovered;
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return { ...draft, skills: [...skills] };
      }),
  });
  return { ...snapshot, checkedAt: DateTime.formatIso(yield* DateTime.now) };
});
