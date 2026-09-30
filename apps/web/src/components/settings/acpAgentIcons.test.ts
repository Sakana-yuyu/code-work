import { expect, it } from "vite-plus/test";
import { acpAgentIconSrc } from "./acpAgentIcons";

it("内置图标优先于 CDN，未知 ID 回退到目录 HTTPS", () => {
  expect(
    acpAgentIconSrc({
      id: "cline",
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/cline.svg",
    }),
  ).toBe("/acp-agent-icons/cline.svg");
  expect(
    acpAgentIconSrc({
      id: "custom-agent",
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/custom-agent.svg",
    }),
  ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/custom-agent.svg");
  expect(acpAgentIconSrc({ id: "unknown" })).toBeNull();
});
