let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const message = JSON.parse(input);
    const context = message?.context;
    const server = context?.mcpConfig?.mcpServers?.["t3-composition-runtime"];
    if (
      message?.schemaVersion !== 1 ||
      message?.type !== "multica.task.start" ||
      typeof context?.taskId !== "string" ||
      typeof context?.runId !== "string" ||
      typeof context?.agentId !== "string" ||
      server?.type !== "http" ||
      typeof server?.url !== "string" ||
      typeof server?.headers?.Authorization !== "string"
    ) {
      process.exitCode = 2;
      return;
    }
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  }
});
