// @effect-diagnostics nodeBuiltinImport:off - 本测试需要真实 Node 子进程验证跨进程文件锁。
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  commitServerSettingsOriginCas,
  readServerSettingsOriginSnapshot,
  withServerSettingsOriginLock,
} from "./serverSettingsOriginCas.ts";
import {
  decodeServerSettingsOriginCasFixtureMessage,
  type ServerSettingsOriginCasFixtureMessage,
} from "./serverSettingsOriginCasFixtureProtocol.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./serverSettingsOriginCasFixture.ts", import.meta.url),
);

interface OriginCasFixture {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly nextMessage: () => Promise<ServerSettingsOriginCasFixtureMessage>;
  readonly errors: ReadonlyArray<string>;
}

interface OriginCasFixtureWaiter {
  readonly resolve: (message: ServerSettingsOriginCasFixtureMessage) => void;
  readonly reject: (error: Error) => void;
}

const startFixture = (settingsPath: string, candidate: string): OriginCasFixture => {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath, settingsPath, candidate], {
    cwd: NodeURL.fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const messages: ServerSettingsOriginCasFixtureMessage[] = [];
  const waiters: OriginCasFixtureWaiter[] = [];
  const errors: string[] = [];
  let terminalError: Error | undefined;
  let closed = false;
  const failWaiters = (error: Error) => {
    if (terminalError !== undefined) return;
    terminalError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  lines.on("line", (line) => {
    let message: ServerSettingsOriginCasFixtureMessage;
    try {
      message = decodeServerSettingsOriginCasFixtureMessage(line);
    } catch (cause) {
      errors.push(`stdout: ${line}\n`);
      failWaiters(new Error("CAS fixture 输出了无效协议消息。", { cause }));
      return;
    }
    const waiter = waiters.shift();
    if (waiter === undefined) messages.push(message);
    else waiter.resolve(message);
  });
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
  child.once("error", (cause) => failWaiters(cause));
  child.once("close", (code) => {
    closed = true;
    if (waiters.length === 0) return;
    failWaiters(
      new Error(
        `CAS fixture 在返回协议消息前关闭，退出码 ${code ?? "unknown"}：${errors.join("")}`,
      ),
    );
  });
  return {
    child,
    errors,
    nextMessage: () => {
      const message = messages.shift();
      if (message !== undefined) return Promise.resolve(message);
      if (terminalError !== undefined) return Promise.reject(terminalError);
      if (closed) return Promise.reject(new Error("CAS fixture 已关闭，且没有待消费的协议消息。"));
      return new Promise<ServerSettingsOriginCasFixtureMessage>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
    },
  };
};

const awaitExit = (fixture: OriginCasFixture): Promise<void> =>
  fixture.child.exitCode === null
    ? new Promise<void>((resolve, reject) => {
        fixture.child.once("error", reject);
        fixture.child.once("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`CAS fixture 退出码 ${code ?? "unknown"}：${fixture.errors.join("")}`),
            );
        });
      })
    : fixture.child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(
          new Error(`CAS fixture 退出码 ${fixture.child.exitCode}：${fixture.errors.join("")}`),
        );

it.effect("多个独立进程以同一磁盘 token 竞争时只有一个提交者获胜", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-settings-cas-"));
  const settingsPath = NodePath.join(tempDir, "settings.json");
  NodeFS.writeFileSync(settingsPath, "{}\n", "utf8");
  const fixtures = ["A", "B", "C", "D"].map((winner) =>
    startFixture(settingsPath, `{"winner":"${winner}"}\n`),
  );

  return Effect.promise(async () => {
    try {
      const ready = await Promise.all(fixtures.map((fixture) => fixture.nextMessage()));
      const readyMessages = ready.flatMap((message) => (message.type === "ready" ? [message] : []));
      assert.equal(readyMessages.length, fixtures.length);
      assert.equal(new Set(readyMessages.map((message) => message.token)).size, 1);

      for (const fixture of fixtures) fixture.child.stdin.end("commit\n");
      const results = await Promise.all(fixtures.map((fixture) => fixture.nextMessage()));
      const resultMessages = results.flatMap((message) =>
        message.type === "result" ? [message] : [],
      );
      assert.equal(resultMessages.length, fixtures.length);
      const committed = resultMessages.filter((message) => message.tag === "Committed");
      const conflicted = resultMessages.filter((message) => message.tag === "Conflict");
      assert.equal(committed.length, 1);
      assert.equal(conflicted.length, fixtures.length - 1);
      const winner = committed[0];
      if (winner === undefined) throw new Error("CAS 竞争未产生唯一提交者。");
      assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), winner.value);
      await Promise.all(fixtures.map(awaitExit));
      assert.isFalse(NodeFS.existsSync(`${settingsPath}.lock`));
      assert.deepEqual(
        NodeFS.readdirSync(tempDir).filter((name) => name.startsWith("settings.json.lock.")),
        [],
      );
    } finally {
      for (const fixture of fixtures) {
        if (fixture.child.exitCode === null) fixture.child.kill();
      }
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("检测到死亡 owner 时 fail-closed 且不改写磁盘", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-dead-lock-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const lockPath = `${path.resolve(settingsPath)}.lock`;
    yield* fileSystem.writeFileString(settingsPath, "{}\n");
    yield* fileSystem.makeDirectory(lockPath);
    yield* fileSystem.writeFileString(
      path.join(lockPath, "owner.json"),
      '{"token":"dead-owner","pid":2147483647,"createdAtUnixMs":0}\n',
    );
    const initial = yield* readServerSettingsOriginSnapshot(settingsPath);

    const error = yield* commitServerSettingsOriginCas({
      settingsPath,
      expectedToken: initial.token,
      prepare: Effect.succeed({
        contents: '{"recovered":true}\n',
        value: true,
        compensate: Effect.void,
      }),
    }).pipe(Effect.flip);

    assert.equal(error._tag, "ServerSettingsOriginError");
    assert.equal(error.operation, "acquire-lock");
    assert.equal(yield* fileSystem.readFileString(settingsPath), "{}\n");
    assert.isTrue(yield* fileSystem.exists(lockPath));
    assert.deepEqual(
      (yield* fileSystem.readDirectory(tempDir)).filter((name) =>
        name.startsWith("settings.json.lock.candidate-"),
      ),
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("owner 被替换时释放锁 fail-closed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-owner-mismatch-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const lockPath = `${path.resolve(settingsPath)}.lock`;
    const error = yield* withServerSettingsOriginLock(
      settingsPath,
      fileSystem
        .writeFileString(
          path.join(lockPath, "owner.json"),
          '{"token":"other-owner","pid":1,"createdAtUnixMs":0}\n',
        )
        .pipe(Effect.orDie),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "ServerSettingsOriginError");
    assert.equal(error.operation, "release-lock");
    assert.isTrue(yield* fileSystem.exists(lockPath));
    yield* fileSystem.remove(lockPath, { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("外部编辑绕过锁时拒绝覆盖并执行补偿", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-external-edit-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const externalRaw = '{"external":true}\n';
    yield* fileSystem.writeFileString(settingsPath, "{}\n");
    const initial = yield* readServerSettingsOriginSnapshot(settingsPath);
    let compensated = false;

    const result = yield* commitServerSettingsOriginCas({
      settingsPath,
      expectedToken: initial.token,
      prepare: fileSystem.writeFileString(settingsPath, externalRaw).pipe(
        Effect.as({
          contents: '{"ours":true}\n',
          value: true,
          compensate: Effect.sync(() => {
            compensated = true;
          }),
        }),
      ),
    });

    assert.equal(result._tag, "Conflict");
    assert.isTrue(compensated);
    assert.equal(yield* fileSystem.readFileString(settingsPath), externalRaw);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
