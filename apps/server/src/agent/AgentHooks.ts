import type { AgentHookEntry, AgentHookEvent, AgentHooksSettings } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import type { ToolBroker, ToolBrokerInput, ToolBrokerResult } from "../composition/ToolBroker.ts";

export type AgentHookPayload = {
  readonly event: AgentHookEvent;
  readonly cwd: string;
  readonly prompt?: string;
  readonly toolName?: string;
  readonly arguments?: unknown;
  readonly result?: unknown;
};

export type AgentHookOutcome = {
  readonly deny: boolean;
  readonly reason?: string;
  readonly extra?: string;
};

const HOOK_TIMEOUT = "10 seconds";
const MAX_HOOK_EXTRA_CHARS = 4_000;

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function hookMatcherMatches(matcher: string, toolName: string): boolean {
  const pattern = matcher.trim();
  if (pattern.length === 0) return true;
  if (!pattern.includes("*")) {
    // 非 glob 匹配按工具名前缀生效，但只在命名空间边界上扩展：
    // "git" 命中 "git.status"，不会误伤 "github.x"。
    return (
      toolName === pattern || toolName.startsWith(pattern.endsWith(".") ? pattern : `${pattern}.`)
    );
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(toolName);
}

export function matchingHooks(
  settings: AgentHooksSettings,
  event: AgentHookEvent,
  toolName?: string,
): ReadonlyArray<AgentHookEntry> {
  if (!settings.enabled) return [];
  return settings.hooks.filter((hook) => {
    if (!hook.enabled || hook.command.trim().length === 0) return false;
    if (hook.event !== event) return false;
    if (event !== "pre_tool_use" && event !== "post_tool_use") return true;
    return hookMatcherMatches(hook.matcher, toolName ?? "");
  });
}

export function parseHookOutput(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}): AgentHookOutcome {
  if (input.timedOut) {
    return { deny: false, extra: "Hook timed out after 10s." };
  }
  const stdout = input.stdout.trim();
  const parsed = parseJsonObject(stdout);
  if (parsed !== undefined) {
    const decision = typeof parsed["decision"] === "string" ? parsed["decision"].toLowerCase() : "";
    const reason =
      typeof parsed["reason"] === "string"
        ? parsed["reason"]
        : typeof parsed["message"] === "string"
          ? parsed["message"]
          : undefined;
    const extra =
      typeof parsed["context"] === "string"
        ? parsed["context"]
        : typeof parsed["extra"] === "string"
          ? parsed["extra"]
          : undefined;
    if (decision === "deny" || decision === "block") {
      return { deny: true, ...(reason === undefined ? {} : { reason }) };
    }
    if (extra !== undefined && extra.trim().length > 0) {
      return { deny: false, extra: clampExtra(extra) };
    }
  }
  if (input.code !== null && input.code !== 0) {
    const reason = (stdout || input.stderr.trim() || `Hook exited with code ${input.code}`).slice(
      0,
      MAX_HOOK_EXTRA_CHARS,
    );
    return { deny: true, reason };
  }
  if (stdout.length === 0) return { deny: false };
  return { deny: false, extra: clampExtra(stdout) };
}

export function formatHooksListing(settings: AgentHooksSettings): string {
  if (!settings.enabled) {
    return "Agent hooks are off. Enable them in Settings → Integrations → Agent hooks.";
  }
  if (settings.hooks.length === 0) {
    return "No agent hooks are configured. Add a command in Settings → Integrations → Agent hooks.";
  }
  const lines = ["Agent hooks (Settings → Integrations → Agent hooks):"];
  for (const hook of settings.hooks) {
    const matcher = hook.matcher.trim().length > 0 ? ` matcher=${hook.matcher}` : "";
    const state = hook.enabled ? "on" : "off";
    lines.push(`- [${state}] ${hook.event}${matcher}: ${hook.command.trim() || "(empty command)"}`);
  }
  lines.push(
    "",
    'Hooks receive JSON on stdin. For pre_tool_use, print {"decision":"deny","reason":"..."} to block a tool. Type /hooks in chat to list them.',
  );
  return lines.join("\n");
}

export const runAgentHooks = (input: {
  readonly settings: AgentHooksSettings;
  readonly payload: AgentHookPayload;
  readonly processRunner: Option.Option<ProcessRunner.ProcessRunner["Service"]>;
  readonly platform: string;
}): Effect.Effect<AgentHookOutcome> =>
  Effect.gen(function* () {
    const hooks = matchingHooks(input.settings, input.payload.event, input.payload.toolName);
    if (hooks.length === 0) return { deny: false };
    if (Option.isNone(input.processRunner)) {
      return { deny: false, extra: "Hooks are configured but the process runner is unavailable." };
    }
    const runner = input.processRunner.value;
    const extras: string[] = [];
    for (const hook of hooks) {
      const spawn = hookSpawn(hook.command, input.platform);
      const run = yield* runner
        .run({
          command: spawn.command,
          args: spawn.args,
          cwd: input.payload.cwd,
          timeout: HOOK_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          stdin: `${encodeUnknownJson(input.payload)}\n`,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              stdout: "",
              stderr: String(cause),
              code: ChildProcessSpawner.ExitCode(1),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            } satisfies ProcessRunner.ProcessRunOutput),
          ),
        );
      const outcome = parseHookOutput({
        stdout: run.stdout,
        stderr: run.stderr,
        code: run.code,
        timedOut: run.timedOut,
      });
      if (outcome.deny) return outcome;
      if (outcome.extra !== undefined && outcome.extra.trim().length > 0) {
        extras.push(outcome.extra.trim());
      }
    }
    if (extras.length === 0) return { deny: false };
    return { deny: false, extra: clampExtra(extras.join("\n\n")) };
  });

export const wrapToolBrokerWithHooks = (
  broker: ToolBroker["Service"],
  options: {
    readonly settings: AgentHooksSettings;
    readonly cwd: string;
    readonly processRunner: Option.Option<ProcessRunner.ProcessRunner["Service"]>;
    readonly platform: string;
  },
): ToolBroker["Service"] => ({
  invoke: (input: ToolBrokerInput) =>
    Effect.gen(function* () {
      const pre = yield* runAgentHooks({
        settings: options.settings,
        processRunner: options.processRunner,
        platform: options.platform,
        payload: {
          event: "pre_tool_use",
          cwd: options.cwd,
          toolName: input.canonicalToolName,
          arguments: input.arguments,
        },
      });
      if (pre.deny) {
        const now = yield* Clock.currentTimeMillis;
        return {
          invocationId: `hook-deny:${input.toolCallId}`,
          taskId: input.taskId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          canonicalToolName: input.canonicalToolName,
          status: "failed" as const,
          errorCode: "hook_denied",
          result: { reason: pre.reason ?? "Blocked by an agent hook." },
          startedAtUnixMs: now,
          finishedAtUnixMs: now,
        } satisfies ToolBrokerResult;
      }
      const result = yield* broker.invoke(input);
      const post = yield* runAgentHooks({
        settings: options.settings,
        processRunner: options.processRunner,
        platform: options.platform,
        payload: {
          event: "post_tool_use",
          cwd: options.cwd,
          toolName: input.canonicalToolName,
          arguments: input.arguments,
          result: result.result,
        },
      });
      if (post.extra === undefined || result.status !== "succeeded") return result;
      return {
        ...result,
        result: { hook: post.extra, result: result.result },
      };
    }),
  cancel: broker.cancel,
});

const hookSpawn = (
  command: string,
  platform: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "/bin/sh", args: ["-c", command] };

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const clampExtra = (value: string): string =>
  value.length <= MAX_HOOK_EXTRA_CHARS ? value : `${value.slice(0, MAX_HOOK_EXTRA_CHARS)}…`;
