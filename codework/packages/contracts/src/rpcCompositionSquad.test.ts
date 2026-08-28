import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("Squad RPC contracts", () => {
  it("把 Squad 查询、生命周期和运行方法注册到 typed RPC group", () => {
    const methods = [
      WS_METHODS.serverListCompositionSquads,
      WS_METHODS.serverGetCompositionSquad,
      WS_METHODS.serverListCompositionSquadRevisions,
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
});
