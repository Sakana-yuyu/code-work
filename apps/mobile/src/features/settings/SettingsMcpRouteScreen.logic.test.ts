import { describe, expect, it } from "vite-plus/test";

import {
  configFromMcpForm,
  emptyMcpForm,
  formFromMcpConfig,
  isValidMcpServerId,
} from "./SettingsMcpRouteScreen.logic";

describe("移动端 MCP 设置逻辑", () => {
  it("校验服务器 ID，并按传输方式生成配置", () => {
    expect(isValidMcpServerId("local-tools")).toBe(true);
    expect(isValidMcpServerId("-local-tools")).toBe(false);

    const form = {
      ...emptyMcpForm(),
      serverId: "local-tools",
      name: "Local tools",
      command: "npx",
      args: "-y\nserver-package",
      cwd: "C:/workspace",
    };
    expect(configFromMcpForm(form)).toMatchObject({
      schemaVersion: 1,
      name: "Local tools",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-package"],
      cwd: "C:/workspace",
    });
  });

  it("编辑脱敏 header 时留空会保留服务端 secret 标记", () => {
    const form = formFromMcpConfig("remote-tools", {
      schemaVersion: 1,
      name: "Remote tools",
      transport: "http",
      args: [],
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
      environment: [],
      enabled: true,
      trusted: true,
    });

    expect(configFromMcpForm(form)?.headers[0]).toMatchObject({
      name: "Authorization",
      value: "",
      valueRedacted: true,
    });

    const replaced = configFromMcpForm({
      ...form,
      headers: [{ ...form.headers[0]!, value: "Bearer replacement" }],
    });
    expect(replaced?.headers[0]).toMatchObject({
      value: "Bearer replacement",
    });
    expect(replaced?.headers[0]?.valueRedacted).toBeUndefined();
  });

  it("拒绝缺少 stdio 命令或远程 URL 的配置", () => {
    expect(
      configFromMcpForm({ ...emptyMcpForm(), serverId: "local-tools", name: "Tools" }),
    ).toBeNull();
    expect(
      configFromMcpForm({
        ...emptyMcpForm(),
        serverId: "remote-tools",
        name: "Remote tools",
        transport: "http",
      }),
    ).toBeNull();
  });
});
