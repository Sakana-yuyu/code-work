import { describe, expect, it } from "vite-plus/test";

import {
  specWorkflowMobileConnectionReady,
  specWorkflowMobileTransport,
} from "./specWorkflowMobilePresentation";

describe("spec workflow mobile connection boundary", () => {
  it("keeps local, remote, relay/tunnel, and SSH labels on the shared connection target", () => {
    expect(specWorkflowMobileTransport("PrimaryConnectionTarget")).toBe("local");
    expect(specWorkflowMobileTransport("BearerConnectionTarget")).toBe("remote");
    expect(specWorkflowMobileTransport("RelayConnectionTarget")).toBe("relay");
    expect(specWorkflowMobileTransport("SshConnectionTarget")).toBe("ssh");
    expect(specWorkflowMobileTransport(undefined)).toBeNull();
  });

  it("只允许已连接环境执行工作流控制操作", () => {
    expect(specWorkflowMobileConnectionReady("connected")).toBe(true);
    expect(specWorkflowMobileConnectionReady("available")).toBe(false);
    expect(specWorkflowMobileConnectionReady("connecting")).toBe(false);
    expect(specWorkflowMobileConnectionReady("reconnecting")).toBe(false);
    expect(specWorkflowMobileConnectionReady("offline")).toBe(false);
    expect(specWorkflowMobileConnectionReady("error")).toBe(false);
  });
});
