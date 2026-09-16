/**
 * SSH 终端 atoms：镜像本地 terminal.ts 的 attach 流 + 会话命令形状，复用
 * web 端 Ghostty 渲染的接线方式；但缓冲状态由 SSH 事件契约直接驱动。
 */
import type { SshTerminalAttachStreamEvent, SshTerminalSessionSnapshot } from "@codework/contracts";
import { WS_METHODS } from "@codework/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface SshTerminalBufferState {
  readonly snapshot: SshTerminalSessionSnapshot | null;
  readonly buffer: string;
  readonly status: SshTerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly version: number;
}

export const EMPTY_SSH_TERMINAL_BUFFER_STATE = Object.freeze<SshTerminalBufferState>({
  snapshot: null,
  buffer: "",
  status: "closed",
  error: null,
  version: 0,
});

export const DEFAULT_MAX_SSH_TERMINAL_BUFFER_BYTES = 512 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) return "";
  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) return buffer;
  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    start += 1;
  }
  return textDecoder.decode(encoded.subarray(start));
}

export function sshTerminalBufferStateFromSnapshot(
  snapshot: SshTerminalSessionSnapshot,
  maxBufferBytes: number,
): SshTerminalBufferState {
  return {
    snapshot,
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    version: 1,
  };
}

export function applySshTerminalAttachStreamEvent(
  current: SshTerminalBufferState,
  event: SshTerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_SSH_TERMINAL_BUFFER_BYTES,
): SshTerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "started":
      return sshTerminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return { ...current, status: "exited", error: null, version: current.version + 1 };
    case "closed":
      return { ...current, status: "closed", error: null, version: current.version + 1 };
    case "error":
      return { ...current, status: "error", error: event.message, version: current.version + 1 };
  }
}

export function createSshTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const sessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId: string };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId]);
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:ssh-terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.sshTerminalAttach>) =>
        subscribe(WS_METHODS.sshTerminalAttach, input).pipe(
          Stream.scan(EMPTY_SSH_TERMINAL_BUFFER_STATE, applySshTerminalAttachStreamEvent),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh-terminal:open",
      tag: WS_METHODS.sshTerminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh-terminal:write",
      tag: WS_METHODS.sshTerminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh-terminal:resize",
      tag: WS_METHODS.sshTerminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: sessionKey },
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh-terminal:close",
      tag: WS_METHODS.sshTerminalClose,
      scheduler: lifecycleScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
  };
}

export type SshTerminalEnvironmentAtoms<R, E> = ReturnType<
  typeof createSshTerminalEnvironmentAtoms<R, E>
>;
