import { expect, it } from "vite-plus/test";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

it("启动层重新合并宿主环境时不补回合成凭据、代理或旧配置目录", () => {
  const host = {
    Path: "C:/synthetic/system/bin", SystemRoot: "C:/synthetic/windows",
    TEMP: "C:/synthetic/temp", OPENAI_API_KEY: "SYNTHETIC_HOST_KEY",
    CLINE_DATA_DIR: "C:/synthetic/live-data", QWEN_HOME: "C:/synthetic/live-qwen",
    NODE_OPTIONS: "--require synthetic-loader", HTTPS_PROXY: "http://synthetic.invalid",
    HOME: "C:/synthetic/live-home", USERPROFILE: "C:/synthetic/live-profile",
  };
  const prepared = isolatedProbeEnvironment("C:/synthetic/probe-home", host);
  const effective = { ...host, ...prepared };
  expect(effective.Path).toBe(host.Path);
  expect(effective.SystemRoot).toBe(host.SystemRoot);
  expect(effective.TEMP).toBe(host.TEMP);
  for (const key of ["OPENAI_API_KEY", "CLINE_DATA_DIR", "QWEN_HOME", "NODE_OPTIONS", "HTTPS_PROXY"]) {
    expect(effective[key as keyof typeof effective]).toBe("");
  }
  expect(effective).toMatchObject({ HOME: "C:/synthetic/probe-home", USERPROFILE: "C:/synthetic/probe-home", APPDATA: "C:/synthetic/probe-home", LOCALAPPDATA: "C:/synthetic/probe-home" });
  expect({ ...effective, OPENAI_API_KEY: "local-test-only" }.OPENAI_API_KEY).toBe("local-test-only");
  expect(host.OPENAI_API_KEY).toBe("SYNTHETIC_HOST_KEY");
});
