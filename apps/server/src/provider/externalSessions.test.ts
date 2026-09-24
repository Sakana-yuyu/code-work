// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { readExternalSession, scanExternalSessions } from "./externalSessions.ts";

const CODEX_ID = "550e8400-e29b-41d4-a716-446655440000";
const CLAUDE_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("外部 CLI 会话扫描", () => {
  it("按项目过滤 Codex 和 Claude，损坏记录不阻断导入", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "codework-external-sessions-"),
    );
    try {
      const project = NodePath.join(root, "project");
      const other = NodePath.join(root, "other");
      const codex = NodePath.join(root, "codex");
      const claude = NodePath.join(root, "claude");
      await Promise.all([
        NodeFSP.mkdir(project),
        NodeFSP.mkdir(other),
        NodeFSP.mkdir(codex),
        NodeFSP.mkdir(claude),
      ]);
      const codexLines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-09-24T01:00:00Z",
          payload: { id: CODEX_ID, cwd: project },
        }),
        "{bad json",
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-24T01:00:01Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "修复登录" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-24T01:00:02Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "已修复" }],
          },
        }),
      ];
      await NodeFSP.writeFile(
        NodePath.join(codex, `rollout-${CODEX_ID}.jsonl`),
        codexLines.join("\n"),
      );
      await NodeFSP.writeFile(
        NodePath.join(claude, `${CLAUDE_ID}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            sessionId: CLAUDE_ID,
            cwd: project,
            timestamp: "2026-09-24T02:00:00Z",
            message: { content: "添加测试" },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: CLAUDE_ID,
            cwd: project,
            timestamp: "2026-09-24T02:00:01Z",
            message: { content: [{ type: "text", text: "完成" }] },
          }),
        ].join("\n"),
      );
      await NodeFSP.writeFile(
        NodePath.join(codex, "other.jsonl"),
        JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: other } }),
      );
      const sessions = await scanExternalSessions({
        projectRoot: project,
        sources: [
          { provider: "codex", dir: codex, providerInstanceId: "codex" },
          { provider: "claudeAgent", dir: claude, providerInstanceId: "claudeAgent" },
        ],
        platform: "win32",
      });
      expect(sessions).toHaveLength(2);
      expect(sessions.map((session) => session.provider).sort()).toEqual(["claudeAgent", "codex"]);
      const imported = await readExternalSession(
        sessions.find((session) => session.provider === "codex")!,
      );
      expect(imported.messages.map((message) => message.text)).toEqual(["修复登录", "已修复"]);
      expect(imported.truncated).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("大历史只保留最近的 1000 条并明确标记截取", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-external-large-"));
    try {
      const project = NodePath.join(root, "project");
      const codex = NodePath.join(root, "codex");
      await NodeFSP.mkdir(project);
      await NodeFSP.mkdir(codex);
      const lines = [
        JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: project } }),
      ];
      for (let index = 0; index < 1_050; index++) {
        lines.push(
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `请求 ${index}` }],
            },
          }),
        );
      }
      await NodeFSP.writeFile(NodePath.join(codex, `rollout-${CODEX_ID}.jsonl`), lines.join("\n"));
      const [candidate] = await scanExternalSessions({
        projectRoot: project,
        sources: [{ provider: "codex", dir: codex, providerInstanceId: "codex" }],
        platform: "win32",
      });
      expect(candidate).toBeDefined();
      const imported = await readExternalSession(candidate!);
      expect(imported.messages).toHaveLength(1_000);
      expect(imported.messages[0]?.text).toBe("请求 50");
      expect(imported.messages.at(-1)?.text).toBe("请求 1049");
      expect(imported.truncated).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("导入总字数有上限，保留最近的消息", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-external-chars-"));
    try {
      const project = NodePath.join(root, "project");
      const codex = NodePath.join(root, "codex");
      await NodeFSP.mkdir(project);
      await NodeFSP.mkdir(codex);
      const lines = [
        JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: project } }),
      ];
      for (let index = 0; index < 110; index++) {
        lines.push(
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `${index}:` + "a".repeat(19_900) }],
            },
          }),
        );
      }
      await NodeFSP.writeFile(NodePath.join(codex, `rollout-${CODEX_ID}.jsonl`), lines.join("\n"));
      const [candidate] = await scanExternalSessions({
        projectRoot: project,
        sources: [{ provider: "codex", dir: codex, providerInstanceId: "codex" }],
        platform: "win32",
      });
      const imported = await readExternalSession(candidate!);
      expect(imported.messages.length).toBeLessThan(110);
      expect(imported.messages[0]?.text.startsWith("10:")).toBe(true);
      expect(imported.messages.at(-1)?.text.startsWith("109:")).toBe(true);
      expect(imported.truncated).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
