import { describe, expect, it } from "vite-plus/test";

import { isMulticaRuntimeActionCurrent } from "./MulticaRuntimeSettings.controller";

describe("MulticaRuntimeSettings controller", () => {
  it("只让同一环境的当前删除请求更新界面", () => {
    const request = { requestId: 7, scopeKey: "environment-a" };

    expect(isMulticaRuntimeActionCurrent(request, 7, "environment-a")).toBe(true);
    expect(isMulticaRuntimeActionCurrent(request, 8, "environment-a")).toBe(false);
    expect(isMulticaRuntimeActionCurrent(request, 7, "environment-b")).toBe(false);
    expect(isMulticaRuntimeActionCurrent(request, null, "environment-a")).toBe(false);
  });
});
