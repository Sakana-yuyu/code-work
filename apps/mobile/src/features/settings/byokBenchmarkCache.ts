import type { EnvironmentId } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import { MobileDatabase } from "../../persistence/mobile-database";
import {
  decodeByokBenchmarkCache,
  type MobileByokBenchmarkEntry,
} from "./byokBenchmarkCache.logic";

export type { MobileByokBenchmarkEntry } from "./byokBenchmarkCache.logic";

const CACHE_KIND = "byok-benchmark" as const;
const CACHE_SCHEMA_VERSION = 1;

const runDatabase = <A>(
  use: (database: MobileDatabase["Service"]) => Effect.Effect<A, unknown>,
): Promise<A> => runtime.runPromise(MobileDatabase.pipe(Effect.flatMap(use)));

export const loadByokBenchmarkCache = async (
  environmentId: EnvironmentId,
  instanceId: string,
): Promise<Readonly<Record<string, MobileByokBenchmarkEntry>>> => {
  try {
    const cached = await runDatabase((database) =>
      database.loadCache(environmentId, CACHE_KIND, instanceId),
    );
    return Option.match(cached, { onNone: () => ({}), onSome: decodeByokBenchmarkCache });
  } catch {
    return {};
  }
};

export const saveByokBenchmarkCache = async (
  environmentId: EnvironmentId,
  instanceId: string,
  entries: Readonly<Record<string, MobileByokBenchmarkEntry>>,
): Promise<void> => {
  try {
    await runDatabase((database) =>
      database.saveCache(
        environmentId,
        CACHE_KIND,
        instanceId,
        CACHE_SCHEMA_VERSION,
        JSON.stringify(entries),
      ),
    );
  } catch {
    // 测速缓存是可丢弃数据，数据库不可用时不影响测速或设置保存。
  }
};
