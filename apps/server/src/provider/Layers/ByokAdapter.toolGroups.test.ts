import { describe, expect, it } from "vite-plus/test";

import { isByokFullAccessTool, isByokProjectTool } from "./ByokAdapter.ts";
import { listCompositionAgentTools } from "../../composition/CompositionToolRegistry.ts";

describe("BYOK ssh.* tool grouping", () => {
  it("registers exactly the six ssh tools", () => {
    const sshTools = listCompositionAgentTools()
      .map((tool) => tool.canonicalToolName)
      .filter((name) => name.startsWith("ssh."))
      .sort();
    expect(sshTools).toEqual([
      "ssh.delete_file",
      "ssh.exec",
      "ssh.list_files",
      "ssh.read_file",
      "ssh.status",
      "ssh.write_file",
    ]);
  });

  it("puts the read-only trio in the project group and the rest in full-access only", () => {
    expect(isByokProjectTool("ssh.status")).toBe(true);
    expect(isByokProjectTool("ssh.list_files")).toBe(true);
    expect(isByokProjectTool("ssh.read_file")).toBe(true);
    expect(isByokProjectTool("ssh.exec")).toBe(false);
    expect(isByokProjectTool("ssh.write_file")).toBe(false);
    expect(isByokProjectTool("ssh.delete_file")).toBe(false);

    expect(isByokFullAccessTool("ssh.exec")).toBe(true);
    expect(isByokFullAccessTool("ssh.write_file")).toBe(true);
    expect(isByokFullAccessTool("ssh.delete_file")).toBe(true);
    // full-access 集合包含 project 集合：只读工具在任何模式都可用。
    expect(isByokFullAccessTool("ssh.status")).toBe(true);
    expect(isByokFullAccessTool("ssh.read_file")).toBe(true);
  });
});
