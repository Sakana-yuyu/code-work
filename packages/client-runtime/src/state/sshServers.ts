/**
 * SSH 服务器管理 atoms：状态采样（15s 轮询）、测试连接与 SFTP 文件操作命令。
 *
 * 服务器配置本体走 ServerSettings（settingsValueAtom / updateSettings 已通用），
 * 这里只承载会变化的运行时读侧。
 */
import { WS_METHODS } from "@codework/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createSshServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const listScheduler = createAtomCommandScheduler();
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ssh:status",
      tag: WS_METHODS.sshGetServerStatus,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
      refreshIntervalMs: 15_000,
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:test-connection",
      tag: WS_METHODS.sshTestConnection,
    }),
    listFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:list-files",
      tag: WS_METHODS.sshListFiles,
      scheduler: listScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.serverId, input.path]),
      },
    }),
    readFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:read-file",
      tag: WS_METHODS.sshReadFile,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:write-file",
      tag: WS_METHODS.sshWriteFile,
    }),
    deleteFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:delete-file",
      tag: WS_METHODS.sshDeleteFile,
    }),
  };
}

export type SshServerEnvironmentAtoms<R, E> = ReturnType<
  typeof createSshServerEnvironmentAtoms<R, E>
>;
