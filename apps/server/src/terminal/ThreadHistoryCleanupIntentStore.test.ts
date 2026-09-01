import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ThreadHistoryCleanupIntentStore from "./ThreadHistoryCleanupIntentStore.ts";

it.layer(NodeServices.layer)("ThreadHistoryCleanupIntentStore", (it) => {
  it.effect("原子写入会创建专用 intent 父目录", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-thread-history-cleanup-intent-",
      });
      const store = yield* ThreadHistoryCleanupIntentStore.make({
        logsDir: path.join(baseDir, "userdata", "logs", "terminals"),
      });
      const intent = {
        version: 1 as const,
        threadId: "persisted-thread",
        attempt: 2,
        nextRetryDelayMs: 4_000,
      };

      yield* store.write(intent);

      assert.isTrue(yield* fileSystem.exists(store.intentsDir));
      assert.isTrue(yield* fileSystem.exists(store.intentPath(intent.threadId)));
      assert.deepEqual(yield* store.readAll(), [intent]);
    }),
  );

  it.effect("损坏或文件名不匹配的 marker 会被隔离且不作为 intent 返回", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-thread-history-cleanup-intent-",
      });
      const store = yield* ThreadHistoryCleanupIntentStore.make({
        logsDir: path.join(baseDir, "userdata", "logs", "terminals"),
      });
      const intent = {
        version: 1 as const,
        threadId: "mismatched-thread",
        attempt: 0,
        nextRetryDelayMs: 1_000,
      };
      yield* store.write(intent);
      yield* fileSystem.rename(
        store.intentPath(intent.threadId),
        path.join(store.intentsDir, "mismatch.json"),
      );
      yield* fileSystem.writeFileString(path.join(store.intentsDir, "corrupt.json"), "not-json");

      assert.deepEqual(yield* store.readAll(), []);
      assert.isFalse(yield* fileSystem.exists(path.join(store.intentsDir, "mismatch.json")));
      assert.isFalse(yield* fileSystem.exists(path.join(store.intentsDir, "corrupt.json")));
      assert.isTrue(yield* fileSystem.exists(store.quarantineDir));
      assert.equal(
        (yield* fileSystem.readDirectory(store.quarantineDir, { recursive: false })).length,
        2,
      );
    }),
  );
});
