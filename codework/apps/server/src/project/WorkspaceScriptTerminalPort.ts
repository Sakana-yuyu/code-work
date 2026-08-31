import type {
  TerminalEvent,
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "@codework/contracts";
import type * as Effect from "effect/Effect";

import type { TerminalSessionInspectionReceipt } from "../terminal/Manager.ts";
import type { TerminalSessionOwner } from "../terminal/TerminalSessionOwnership.ts";
import type { WorkspaceScriptDependencyError } from "./WorkspaceScriptErrors.ts";

export type WorkspaceScriptTerminalRunCommandInput = TerminalOpenInput & {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly owner: TerminalSessionOwner;
};

export interface WorkspaceScriptTerminalPort {
  readonly runCommand: (
    input: WorkspaceScriptTerminalRunCommandInput,
  ) => Effect.Effect<TerminalSessionSnapshot, WorkspaceScriptDependencyError>;
  readonly kill: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly expectedOwner: TerminalSessionOwner;
  }) => Effect.Effect<void, WorkspaceScriptDependencyError>;
  readonly inspectSessionReceipt: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly expectedOwner: TerminalSessionOwner;
  }) => Effect.Effect<TerminalSessionInspectionReceipt, WorkspaceScriptDependencyError>;
  readonly getHistory: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<string, WorkspaceScriptDependencyError>;
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}
