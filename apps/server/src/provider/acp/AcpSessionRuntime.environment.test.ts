import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, vi } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

for (const extendEnv of [false, true, undefined]) {
  it.effect(`extendEnv=${extendEnv} 时只有明确关闭继承才严格使用目录环境快照`, () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const snapshot = { CATALOG_SNAPSHOT: "original" };
      vi.stubEnv("CATALOG_AMBIENT_SYNTHETIC", "added-after-snapshot");
      try {
        const exit = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* runtime.prepareClient();
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: process.execPath,
                args: ["--version"],
                env: snapshot,
                ...(extendEnv !== undefined ? { extendEnv } : {}),
              },
              cwd: process.cwd(),
              authMethodId: "",
              clientInfo: { name: "catalog-environment-test", version: "0.0.0" },
            }).pipe(
              Layer.provide(
                Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
                  spawn: (command) => {
                    commands.push(command);
                    return Effect.die("已记录最终启动参数，不启动测试进程");
                  },
                }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.scoped,
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(commands).toHaveLength(1);
        const command = commands[0];
        if (command?._tag !== "StandardCommand") throw new Error("缺少实际启动命令");
        expect(command.options.extendEnv).toBe(false);
        expect(command.options.env?.CATALOG_SNAPSHOT).toBe("original");
        expect(command.options.env?.CATALOG_AMBIENT_SYNTHETIC).toBe(
          extendEnv === false ? undefined : "added-after-snapshot",
        );
        if (extendEnv === false)
          expect(Object.keys(command.options.env ?? {})).toEqual(Object.keys(snapshot));
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );
}
