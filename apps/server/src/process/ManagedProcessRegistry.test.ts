import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ManagedProcessRegistry from "./ManagedProcessRegistry.ts";

const makeRegistry = (input: {
  readonly directory: string;
  readonly inspections: ReadonlyMap<number, ManagedProcessRegistry.ManagedProcessInspection>;
  readonly terminated: number[];
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const table: ManagedProcessRegistry.ManagedProcessTable = {
      inspect: (pid) =>
        Effect.succeed(
          input.inspections.get(pid) ??
            ({ _tag: "not-found" } satisfies ManagedProcessRegistry.ManagedProcessInspection),
        ),
    };
    return yield* ManagedProcessRegistry.makeManagedProcessRegistry({
      directory: input.directory,
      table,
      fileSystem,
      path,
      terminate: (pid) => Effect.sync(() => input.terminated.push(pid)),
    });
  });

const withTempDirectory = <A, E, R>(
  effect: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectory({ prefix: "codework-managed-procs-" });
    const result = yield* Effect.exit(effect(directory));
    yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
    return yield* result;
  });

const encodeRecord = Schema.encodeEffect(
  Schema.fromJsonString(ManagedProcessRegistry.ManagedProcessRecord),
);
const decodeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedProcessRegistry.ManagedProcessRecord),
);

const writeRecordFile = (directory: string, record: ManagedProcessRegistry.ManagedProcessRecord) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contents = yield* encodeRecord(record);
    yield* fileSystem.writeFileString(path.join(directory, `${record.id}.json`), contents);
  });

const aliveInspection = (
  pid: number,
  identity: { commandLine?: string | null; startedAt?: string | null },
): ManagedProcessRegistry.ManagedProcessInspection => ({
  _tag: "alive",
  snapshot: {
    pid,
    commandLine: identity.commandLine ?? null,
    startedAt: identity.startedAt ?? null,
  },
});

const sampleRecord = (
  overrides: Partial<ManagedProcessRegistry.ManagedProcessRecord> = {},
): ManagedProcessRegistry.ManagedProcessRecord => ({
  id: "record-1",
  owner: { provider: "opencode", kind: "helper-server" },
  pid: 4242,
  command: "/usr/bin/opencode",
  args: ["serve", "--port=6767"],
  metadata: {},
  identity: { commandLine: null, startedAt: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

it.layer(NodeServices.layer)("ManagedProcessRegistry", (it) => {
  it.effect("record writes an atomic file with the inspected identity snapshot", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [
            4242,
            aliveInspection(4242, {
              commandLine: "opencode serve --port=6767",
              startedAt: "Sat Jun 20 10:30:40 2026",
            }),
          ],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated: [] });

        const record = yield* registry.record({
          owner: { provider: "opencode", kind: "helper-server" },
          pid: 4242,
          command: "/usr/bin/opencode",
          args: ["serve", "--port=6767"],
          metadata: { port: 6767 },
        });

        assert.strictEqual(record.identity.commandLine, "opencode serve --port=6767");
        assert.strictEqual(record.identity.startedAt, "Sat Jun 20 10:30:40 2026");
        assert.strictEqual(record.metadata.port, 6767);
        const raw = yield* fileSystem.readFileString(path.join(directory, `${record.id}.json`));
        const parsed = yield* decodeRecord(raw);
        assert.strictEqual(parsed.pid, 4242);
      }),
    ),
  );

  it.effect("record stores null identity when the process table finds nothing", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry({
          directory,
          inspections: new Map(),
          terminated: [],
        });
        const record = yield* registry.record({
          owner: { provider: "codex", kind: "session-transport" },
          pid: 9001,
          command: "codex",
          args: ["app-server"],
        });
        assert.isNull(record.identity.commandLine);
        assert.isNull(record.identity.startedAt);
      }),
    ),
  );

  it.effect("list skips corrupt records instead of failing the reconcile", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const record = sampleRecord();
        yield* writeRecordFile(directory, record);
        yield* fileSystem.writeFileString(path.join(directory, "corrupt.json"), "{not json");
        yield* fileSystem.writeFileString(path.join(directory, "notes.txt"), "ignored");

        const registry = yield* makeRegistry({
          directory,
          inspections: new Map(),
          terminated: [],
        });
        const records = yield* registry.list();
        assert.deepStrictEqual(records, [record]);
      }),
    ),
  );

  it.effect("reapStale removes dead records without touching the process table", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const record = sampleRecord();
        yield* writeRecordFile(directory, record);

        const terminated: number[] = [];
        const registry = yield* makeRegistry({
          directory,
          inspections: new Map(),
          terminated,
        });
        const result = yield* registry.reapStale();

        assert.strictEqual(result.dead, 1);
        assert.strictEqual(result.removed, 1);
        assert.strictEqual(result.terminated, 0);
        assert.deepStrictEqual(terminated, []);
        assert.strictEqual(
          yield* fileSystem.exists(path.join(directory, `${record.id}.json`)),
          false,
        );
      }),
    ),
  );

  it.effect("reapStale keeps records whose inspection errored", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const record = sampleRecord();
        yield* writeRecordFile(directory, record);

        const terminated: number[] = [];
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [record.pid, { _tag: "error", error: new Error("ps failed") }],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated });
        const result = yield* registry.reapStale();

        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.removed, 0);
        assert.strictEqual(result.terminated, 0);
        assert.deepStrictEqual(terminated, []);
        assert.strictEqual(
          yield* fileSystem.exists(path.join(directory, `${record.id}.json`)),
          true,
        );
      }),
    ),
  );

  it.effect("reapStale deletes mismatched records without killing the reused pid", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const record = sampleRecord({
          identity: {
            commandLine: "opencode serve --port=6767",
            startedAt: "Sat Jun 20 10:30:40 2026",
          },
        });
        yield* writeRecordFile(directory, record);

        // The pid now belongs to a different process started at another time.
        const terminated: number[] = [];
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [
            record.pid,
            aliveInspection(record.pid, {
              commandLine: "vim README.md",
              startedAt: "Sat Jun 20 11:00:00 2026",
            }),
          ],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated });
        const result = yield* registry.reapStale();

        assert.strictEqual(result.mismatched, 1);
        assert.strictEqual(result.removed, 1);
        assert.strictEqual(result.terminated, 0);
        assert.deepStrictEqual(terminated, []);
        assert.strictEqual(
          yield* fileSystem.exists(path.join(directory, `${record.id}.json`)),
          false,
        );
      }),
    ),
  );

  it.effect("reapStale terminates a surviving leftover and removes its record", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const record = sampleRecord({
          identity: {
            commandLine: "opencode serve --port=6767",
            startedAt: "Sat Jun 20 10:30:40 2026",
          },
        });
        yield* writeRecordFile(directory, record);

        const terminated: number[] = [];
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [
            record.pid,
            aliveInspection(record.pid, {
              commandLine: "opencode serve --port=6767",
              startedAt: "Sat Jun 20 10:30:40 2026",
            }),
          ],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated });
        const result = yield* registry.reapStale();

        assert.strictEqual(result.terminated, 1);
        assert.strictEqual(result.removed, 1);
        assert.deepStrictEqual(terminated, [record.pid]);
        assert.strictEqual(
          yield* fileSystem.exists(path.join(directory, `${record.id}.json`)),
          false,
        );
      }),
    ),
  );

  it.effect("reapStale matches on the command signature when no start timestamp exists", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const record = sampleRecord();
        yield* writeRecordFile(directory, record);

        const terminated: number[] = [];
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [
            record.pid,
            aliveInspection(record.pid, {
              commandLine: "/usr/bin/opencode serve --port=6767 --hostname=0.0.0.0",
            }),
          ],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated });
        const result = yield* registry.reapStale();
        assert.strictEqual(result.terminated, 1);
        assert.deepStrictEqual(terminated, [record.pid]);
      }),
    ),
  );

  it.effect("reapStale does not match a pid whose command line merely shares tokens", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const record = sampleRecord();
        yield* writeRecordFile(directory, record);

        const terminated: number[] = [];
        const inspections = new Map<number, ManagedProcessRegistry.ManagedProcessInspection>([
          [
            record.pid,
            aliveInspection(record.pid, {
              commandLine: "grep opencode notes/serve--port=6767.txt",
            }),
          ],
        ]);
        const registry = yield* makeRegistry({ directory, inspections, terminated });
        const result = yield* registry.reapStale();
        assert.strictEqual(result.mismatched, 1);
        assert.deepStrictEqual(terminated, []);
      }),
    ),
  );

  it.effect("recordSpawnedChild returns none when the registry is not provided", () =>
    Effect.gen(function* () {
      const record = yield* ManagedProcessRegistry.recordSpawnedChild({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 1,
        command: "opencode",
        args: [],
      });
      assert.isTrue(Option.isNone(record));
    }).pipe(Effect.provide(Layer.empty)),
  );
});
