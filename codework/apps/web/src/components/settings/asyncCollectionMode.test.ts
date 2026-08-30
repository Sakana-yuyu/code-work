import { describe, expect, it } from "vite-plus/test";

import { resolveAsyncCollectionCreationMode } from "./asyncCollectionMode";

describe("resolveAsyncCollectionCreationMode", () => {
  it("查询尚未完成时不把暂时空集误判为新建态", () => {
    expect(
      resolveAsyncCollectionCreationMode({
        createRequested: false,
        isPending: true,
        itemCount: 0,
      }),
    ).toBe(false);
  });

  it("查询完成且集合为空时进入新建态", () => {
    expect(
      resolveAsyncCollectionCreationMode({
        createRequested: false,
        isPending: false,
        itemCount: 0,
      }),
    ).toBe(true);
  });

  it("查询完成且存在记录时进入编辑态", () => {
    expect(
      resolveAsyncCollectionCreationMode({
        createRequested: false,
        isPending: false,
        itemCount: 1,
      }),
    ).toBe(false);
  });

  it("用户主动新建时不会被异步返回的记录覆盖", () => {
    expect(
      resolveAsyncCollectionCreationMode({
        createRequested: true,
        isPending: false,
        itemCount: 1,
      }),
    ).toBe(true);
  });
});
