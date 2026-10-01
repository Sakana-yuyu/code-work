import { describe, expect, it } from "vite-plus/test";
import { mergeCliProxyResult, type CliProxyResult } from "./cliProxy.ts";
import { LocalAccountId } from "./localAccount.ts";

const a = LocalAccountId.make("account-a");
const b = LocalAccountId.make("account-b");
const snapshot: CliProxyResult = {
  config: { strategy: "round-robin" },
  running: true,
  version: "embedded",
  baseUrl: "/v1",
  accounts: [],
  localAccounts: [a, b].map((id) => ({
    id,
    provider: "codex",
    displayName: id,
    enabled: true,
    models: [],
  })),
};

describe("账号池按数据面合并快照", () => {
  it("普通刷新保留额度；单账号刷新保留其他账号；删除清除残留", () => {
    const previous = {
      ...snapshot,
      accountSubscriptions: [
        { id: a, plan: "Pro", windows: [] },
        { id: b, plan: "Plus", windows: [] },
      ],
    };
    expect(mergeCliProxyResult(previous, snapshot).accountSubscriptions).toEqual(
      previous.accountSubscriptions,
    );
    const refreshed = mergeCliProxyResult(previous, {
      ...snapshot,
      accountSubscriptions: [{ id: a, windows: [], error: "登录失效" }],
    });
    expect(refreshed.accountSubscriptions).toEqual([
      { id: a, windows: [], error: "登录失效" },
      previous.accountSubscriptions[1],
    ]);
    expect(
      mergeCliProxyResult(refreshed, { ...snapshot, localAccounts: [] }).accountSubscriptions,
    ).toEqual([]);
  });
  it("普通状态不保留一次性明文 Key", () => {
    const previous = {
      ...snapshot,
      externalGateway: {
        keys: [],
        openaiBaseUrl: "/v1",
        anthropicBaseUrl: "/anthropic",
        issuedKey: "one-time",
      },
    };
    expect(JSON.stringify(mergeCliProxyResult(previous, snapshot))).not.toContain("one-time");
  });
});
