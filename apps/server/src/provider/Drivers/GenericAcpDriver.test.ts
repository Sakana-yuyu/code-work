import { describe, expect, it } from "@effect/vitest";

import { classifyAcpCommandProbe } from "./GenericAcpDriver.ts";

describe("GenericAcpDriver 命令探测", () => {
  it("退出码非零时不会把已启动的进程误报为就绪", () => {
    expect(classifyAcpCommandProbe({ stdout: "", stderr: "unknown option", exitCode: 2 })).toEqual({
      status: "error",
      message: "ACP Agent 探测返回退出码 2；请检查安装状态和启动参数。",
    });
  });

  it("仅成功退出时显示有界的诊断输出", () => {
    const outcome = classifyAcpCommandProbe({
      stdout: "v1.2.3".repeat(40),
      stderr: "",
      exitCode: 0,
    });
    expect(outcome.status).toBe("ready");
    expect(outcome.message.length).toBeLessThanOrEqual(135);
  });
});
