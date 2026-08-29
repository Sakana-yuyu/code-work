import { describe, expect, it } from "vite-plus/test";

import {
  CompositionSquadExecutionListRequest,
  CompositionSquadExecutionListResult,
  CompositionSquadExecutionSummaryListRequest,
  CompositionSquadExecutionSummaryListResult,
} from "./composition.ts";
import {
  WS_METHODS,
  WsRpcGroup,
  WsServerListCompositionSquadExecutionSummariesRpc,
  WsServerListCompositionSquadExecutionsRpc,
} from "./rpc.ts";

describe("Squad RPC contracts", () => {
  it("把 Squad 查询、生命周期和运行方法注册到 typed RPC group", () => {
    const methods = [
      WS_METHODS.serverListCompositionSquads,
      WS_METHODS.serverGetCompositionSquad,
      WS_METHODS.serverListCompositionSquadRevisions,
      WS_METHODS.serverListCompositionSquadExecutions,
      WS_METHODS.serverListCompositionSquadExecutionSummaries,
      WS_METHODS.serverCreateCompositionSquad,
      WS_METHODS.serverUpdateCompositionSquad,
      WS_METHODS.serverDuplicateCompositionSquad,
      WS_METHODS.serverArchiveCompositionSquad,
      WS_METHODS.serverRestoreCompositionSquad,
      WS_METHODS.serverRunCompositionSquad,
    ];

    expect(methods).toEqual([
      "server.listCompositionSquads",
      "server.getCompositionSquad",
      "server.listCompositionSquadRevisions",
      "server.listCompositionSquadExecutions",
      "server.listCompositionSquadExecutionSummaries",
      "server.createCompositionSquad",
      "server.updateCompositionSquad",
      "server.duplicateCompositionSquad",
      "server.archiveCompositionSquad",
      "server.restoreCompositionSquad",
      "server.runCompositionSquad",
    ]);
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("把 execution 历史请求和结果 Schema 绑定到注册的 typed RPC", () => {
    expect(WsServerListCompositionSquadExecutionsRpc.payloadSchema).toBe(
      CompositionSquadExecutionListRequest,
    );
    expect(WsServerListCompositionSquadExecutionsRpc.successSchema).toBe(
      CompositionSquadExecutionListResult,
    );
    expect(WsRpcGroup.requests.get(WS_METHODS.serverListCompositionSquadExecutions)).toBe(
      WsServerListCompositionSquadExecutionsRpc,
    );
  });

  it("把有上限的 execution 摘要 Schema 绑定到独立只读 RPC", () => {
    expect(WsServerListCompositionSquadExecutionSummariesRpc.payloadSchema).toBe(
      CompositionSquadExecutionSummaryListRequest,
    );
    expect(WsServerListCompositionSquadExecutionSummariesRpc.successSchema).toBe(
      CompositionSquadExecutionSummaryListResult,
    );
    expect(WsRpcGroup.requests.get(WS_METHODS.serverListCompositionSquadExecutionSummaries)).toBe(
      WsServerListCompositionSquadExecutionSummariesRpc,
    );
  });
});
