declare const TerminalSessionOwnerBrand: unique symbol;

/** 仅服务端可构造；客户端 terminalId 不能伪造 Workspace Script 会话归属。 */
export interface TerminalSessionOwner {
  readonly workspaceScriptRunId: string;
  readonly generation: number;
  readonly [TerminalSessionOwnerBrand]: true;
}

export const makeWorkspaceScriptTerminalOwner = (input: {
  readonly workspaceScriptRunId: string;
  readonly generation: number;
}): TerminalSessionOwner => Object.freeze({ ...input }) as TerminalSessionOwner;

export const terminalSessionOwnerEquals = (
  actual: TerminalSessionOwner | null,
  expected: TerminalSessionOwner | undefined,
): boolean =>
  expected === undefined
    ? actual === null
    : actual !== null &&
      actual.workspaceScriptRunId === expected.workspaceScriptRunId &&
      actual.generation === expected.generation;
